import {
  getOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
  WORKSPACE_ROLE_LABEL,
  WORKSPACE_MAIN_ROLE,
} from "@getpaseo/protocol/agent-labels";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { createAntigravityProvider } from "../../../../../plugins/antigravity-provider/server/provider.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createPersistedWorkspaceRecord } from "../workspace-registry.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { AgentManager } from "./agent-manager.js";
import { formatAgentMessage } from "./agent-messages/envelope.js";
import type { AgentStreamEvent, AgentTimelineItem } from "./agent-sdk-types.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import { PluginAgentClientRegistry } from "./plugin-provider.js";
import { sliceTimelineRowsAtBoundary } from "./timeline-prefix-store.js";
import { summarizeWorkspaceAgents } from "./workspace-agents-summary.js";

test.each(["legacy", "scoped"] as const)(
  "retains independent Antigravity protocol messages in chat and cold summary with a %s prefix",
  async (prefixFormat) => {
    const cwd = await mkdtemp(join(tmpdir(), "antigravity-protocol-history-"));
    const logger = pino({ level: "silent" });
    const storage = new AgentStorage(join(cwd, "agents"), logger);
    const providers = new PluginAgentClientRegistry(logger);
    const executable = join(cwd, "agy.cjs");
    const provider = createAntigravityProvider();
    providers.replace([
      {
        ...provider,
        command: [process.execPath, executable],
        connect: (options) =>
          provider.connect({
            ...options,
            launch: options.launch && {
              ...options.launch,
              env: { ...options.launch.env, HOME: cwd },
            },
          }),
      },
    ]);
    const newManager = () =>
      new AgentManager({
        clients: providers.clients(),
        providerDefinitions: providers.definitions(),
        registry: storage,
        logger,
      });
    const original = newManager();
    const manager = newManager();
    const reopened = newManager();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "wks_1234567890abcdef",
      projectId: "prj_1234567890abcdef",
      cwd,
      kind: "directory",
      displayName: "Antigravity",
      createdAt,
      updatedAt: createdAt,
    });
    const { workspaceId } = workspace;
    const loadChat = async (agentManager: AgentManager, agentId: string) => {
      await ensureAgentLoaded(agentId, {
        agentManager,
        agentStorage: storage,
        logger,
        purpose: "history",
      });
      return agentManager.fetchTimeline(agentId, { limit: 0 });
    };
    const sourceId = "00000000-0000-4000-8000-000000000101";
    const targetId = "00000000-0000-4000-8000-000000000102";
    try {
      // Only the external command is substituted. Both readers use Antigravity's
      // actual ACP connection, plugin bridge and timeline loading paths.
      await writeFile(
        executable,
        `
        const { createInterface } = require("node:readline");
        const { appendFileSync } = require("node:fs");
        createInterface({ input: process.stdin }).on("line", (line) => {
          const { id, method, params } = JSON.parse(line);
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
            return;
          }
          if (method === "session/load") {
            const source = params.sessionId === "source-native";
            appendFileSync("replay-processes.log", JSON.stringify({ pid: process.pid, source }) + "\\n");
            const update = (update) => send({ method: "session/update", params: { sessionId: params.sessionId, update } });
            const user = (text) => update({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
            const reply = (text, messageId) => update({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
            user(source ? "Source prompt." : "Target prompt.");
            reply(source ? "Source reply." : "Target reply.");
            user("Continue.");
            reply("Do");
            reply("ne.");
            if (source) reply("Source boundary.", "native-boundary");
            update({ sessionUpdate: "available_commands_update", availableCommands: [] });
            send({ id, result: { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
            return;
          }
          if (method === "session/prompt") {
            for (const text of ["Do", "ne."]) {
              send({ method: "session/update", params: { sessionId: params.sessionId, update: {
                sessionUpdate: "agent_message_chunk", content: { type: "text", text },
              } } });
            }
            send({ id, result: { stopReason: "end_turn" } });
            return;
          }
          send({ id, result: {} });
        });
        function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n"); }
      `,
      );
      for (const [id, nativeId] of [
        [sourceId, "source-native"],
        [targetId, "target-native"],
      ]) {
        await storage.upsert({
          id,
          provider: "antigravity",
          cwd,
          workspaceId,
          labels: {},
          metadata: {},
          lastStatus: "closed",
          createdAt,
          updatedAt: createdAt,
          persistence: {
            provider: "antigravity",
            sessionId: `plugin:${JSON.stringify({ version: 1, data: { sessionId: nativeId } })}`,
          },
        });
      }
      const source = await loadChat(original, sourceId);
      const target = await loadChat(original, targetId);
      const sourceRows = sliceTimelineRowsAtBoundary(source.rows, {
        boundaryMessageId: "native-boundary",
      });
      const targetFirstReply = target.rows[1]?.item;
      if (targetFirstReply?.type !== "assistant_message" || !targetFirstReply.messageId) {
        throw new Error("Target's first assistant reply must be addressable");
      }
      const targetRows = sliceTimelineRowsAtBoundary(target.rows, {
        boundaryMessageId: targetFirstReply.messageId,
      });
      const prefixRows = [
        ...sourceRows.map(({ item, timestamp }, index) => ({
          seq: index + 1,
          timestamp,
          item:
            prefixFormat === "legacy" && (index === 2 || index === 3)
              ? {
                  ...item,
                  messageId: index === 2 ? "user_message_chunk:3" : "agent_message_chunk:4",
                }
              : item,
        })),
        ...targetRows.map(({ item, timestamp }, index) => ({
          seq: sourceRows.length + index + 1,
          timestamp,
          item,
        })),
      ];
      await storage.timelinePrefixes.save(targetId, { version: 1, rows: prefixRows });

      const summary = await summarizeWorkspaceAgents({
        workspaceId,
        agentManager: manager,
        agentStorage: storage,
        workspaceRegistry: { get: async () => workspace },
        logger,
      });
      expect.soft(summary.entries.find(({ agentId }) => agentId === targetId)).toMatchObject({
        firstUserPrompt: "Source prompt.",
        lastAssistantSummary: "Done.",
      });
      expect(manager.getAgent(targetId)).toBeNull();
      const coldItems = await manager.readTimelineForSummary(targetId, workspaceId);
      const chat = await loadChat(manager, targetId);
      const expected = [
        ...prefixRows.map(({ item }) => item),
        ...target.rows.slice(2).map(({ item }) => item),
      ];
      expect.soft(coldItems).toEqual(expected);
      expect.soft(chat.rows.map(({ item }) => item)).toEqual(expected);
      expect(chat.rows.map(({ item }) => ("text" in item ? item.text : item.type))).toEqual([
        "Source prompt.",
        "Source reply.",
        "Continue.",
        "Done.",
        "Source boundary.",
        "Target prompt.",
        "Target reply.",
        "Continue.",
        "Done.",
      ]);
      const earlierReplies = chat.rows
        .map(({ item }) => item)
        .filter((item) => item.type === "assistant_message" && item.text === "Done.");
      expect(earlierReplies).toHaveLength(2);
      expect(earlierReplies[0]?.messageId).not.toBe(earlierReplies[1]?.messageId);
      for (const item of earlierReplies) {
        const located = sliceTimelineRowsAtBoundary(chat.rows, {
          boundaryMessageId: item.messageId!,
        });
        expect(located.at(-1)?.item).toEqual(item);
      }

      if (prefixFormat === "scoped") {
        const withSameSourceReply = [
          ...prefixRows,
          ...target.rows.slice(2).map(({ item, timestamp }, index) => ({
            seq: prefixRows.length + index + 1,
            timestamp,
            item,
          })),
        ];
        await storage.timelinePrefixes.save(targetId, { version: 1, rows: withSameSourceReply });
        expect(await reopened.readTimelineForSummary(targetId, workspaceId)).toEqual(expected);

        // The cold summary releases its ACP process before interactive chat opens.
        const replayProcesses = (await readFile(join(cwd, "replay-processes.log"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { pid: number; source: boolean });
        const reader = replayProcesses.at(-1)!;
        expect(reader.source).toBe(false);
        expect(() => process.kill(reader.pid, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
        expect((await loadChat(reopened, targetId)).rows.map(({ item }) => item)).toEqual(expected);
        await reopened.runAgent(targetId, "Run it again.", { clientMessageId: "live-prompt" });
        const liveRows = reopened.fetchTimeline(targetId, { limit: 0 }).rows;
        expect(liveRows.slice(0, expected.length).map(({ item }) => item)).toEqual(expected);
        expect(liveRows.slice(expected.length).map(({ item }) => item)).toEqual([
          {
            type: "user_message",
            text: "Run it again.",
            messageId: "live-prompt",
            clientMessageId: "live-prompt",
          },
          {
            type: "assistant_message",
            text: "Done.",
            messageId: expect.stringMatching(/^agent_message_chunk:\d+$/),
          },
        ]);
      }
    } finally {
      for (const instance of [original, manager, reopened]) {
        await Promise.all(instance.listAgents().map(({ id }) => instance.closeAgent(id)));
        await instance.flush();
      }
      await providers.shutdown();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

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
      title: "Finished work",
      parentAgentId: live.id,
      firstUserPrompt: null,
      lastAssistantSummary: null,
      todos: [],
      touchedFiles: ["src/example.ts"],
    });
    expect(result.entries[2]).toMatchObject({ title: "Incomplete history", firstUserPrompt: null });
    expect(result.summaryText).toContain("## Active Sessions");
    expect(result.summaryText).toContain("## Closed Sessions");
    expect(result.summaryText).toContain("src/example.ts");
    expect(result.summaryText).not.toMatch(/Add coverage|Added coverage|Run tests/);
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

async function readStoredFiles(dir: string) {
  const names = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return Promise.all(
    names.map(async (path) => {
      const { ino, mtimeMs } = await stat(path);
      return { path, ino, mtimeMs, bytes: await readFile(path) };
    }),
  );
}

test.each([
  { operation: "switch", replay: "available" },
  { operation: "fork", replay: "available" },
  { operation: "fork", replay: "no handle" },
  { operation: "switch", replay: "failed" },
])(
  "summarizes retained history after a $operation with $replay provider replay",
  async ({ operation, replay }) => {
    const cwd = await mkdtemp(join(tmpdir(), "workspace-summary-prefix-"));
    const logger = pino({ level: "silent" });
    const agentsDir = join(cwd, "agents");
    const storage = new AgentStorage(agentsDir, logger);
    const createdAt = "2026-01-01T00:00:00.000Z";
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "wks_1234567890abcdef",
      projectId: "prj_1234567890abcdef",
      cwd,
      kind: "directory",
      displayName: "Summary workspace",
      createdAt,
      updatedAt: createdAt,
    });
    const { workspaceId } = workspace;
    const workspaceRegistry = { get: async () => workspace };

    const firstPrompt = {
      type: "user_message",
      text: "Add a parser",
      messageId: "request-1",
    } as const;
    const priorConclusion = {
      type: "assistant_message",
      text: "Parser added",
      messageId: "reply-1",
    } as const;
    const repeatedPrompt = { ...firstPrompt, messageId: "request-2" };
    const originalEdit = {
      type: "tool_call",
      name: "Edit",
      callId: "session-local-edit",
      status: "completed",
      error: null,
      detail: { type: "edit", filePath: "src/parser.ts" },
    } as const;
    const followup: AgentTimelineItem[] = [
      { type: "user_message", text: "Cover the empty input case" },
      { ...originalEdit, detail: { type: "edit", filePath: "src/parser.test.ts" } },
      { type: "assistant_message", text: "Empty input covered", messageId: "reply-1" },
    ];

    const codex = createTestAgentClient("codex");
    const originalManager = new AgentManager({
      clients: { codex, claude: createTestAgentClient("claude") },
      registry: storage,
      logger,
    });
    const historyReads: Array<{ purpose?: string; closes: number }> = [];
    const createdProviders: string[] = [];
    const startedTurns: string[] = [];
    const revivedClaude = createTestAgentClient("claude", {
      beforeCreateSession: async () => {
        createdProviders.push("claude");
      },
      onStartTurn: () => {
        startedTurns.push("claude");
      },
    });
    const resume = revivedClaude.resumeSession.bind(revivedClaude);
    revivedClaude.resumeSession = async (handle, config, launchContext, options) => {
      const read = { purpose: options?.purpose, closes: 0 };
      historyReads.push(read);
      const session = await resume(handle, config, launchContext, options);
      const close = session.close.bind(session);
      session.close = async () => {
        read.closes++;
        await close();
      };
      session.streamHistory = async function* () {
        yield {
          type: "timeline",
          provider: "claude",
          item: repeatedPrompt,
          timestamp: "2026-01-02T00:00:00.000Z",
        } as const;
        for (const item of followup) yield { type: "timeline", provider: "claude", item } as const;
        if (replay === "failed") throw new Error("Provider history is unavailable");
        // A provider may replay messages already retained in the fork or switch.
        for (const item of [firstPrompt, priorConclusion]) {
          yield { type: "timeline", provider: "claude", item } as const;
        }
      };
      return session;
    };
    const restartedStorage = new AgentStorage(agentsDir, logger);
    const restartedManager = new AgentManager({
      clients: {
        codex: createTestAgentClient("codex", {
          beforeCreateSession: async () => {
            createdProviders.push("codex");
          },
          onStartTurn: () => {
            startedTurns.push("codex");
          },
        }),
        claude: revivedClaude,
      },
      registry: restartedStorage,
      logger,
    });
    const events: string[] = [];
    const unsubscribe = restartedManager.subscribe((event) => events.push(event.type), {
      replayState: false,
    });

    try {
      const source = await originalManager.createAgent({ provider: "codex", cwd }, undefined, {
        workspaceId,
      });
      for (const item of [firstPrompt, originalEdit, priorConclusion]) {
        await originalManager.appendTimelineItem(source.id, item);
      }
      let id = source.id;
      if (operation === "switch") {
        await originalManager.switchAgentProvider(id, { provider: "claude", model: "haiku" });
      } else {
        const { rows, epoch } = originalManager.fetchTimeline(source.id, { limit: 0 });
        await originalManager.appendTimelineItem(source.id, {
          type: "assistant_message",
          text: "Outside the selected history",
          messageId: "outside-fork",
        });
        const currentRows = originalManager.fetchTimeline(source.id, { limit: 0 }).rows;
        const fork = await originalManager.createAgent({ provider: "claude", cwd }, undefined, {
          workspaceId,
          forkedTimelineRows: sliceTimelineRowsAtBoundary(currentRows, {
            boundaryCursor: { epoch, seq: rows.at(-1)!.seq },
            timelineEpoch: epoch,
          }),
        });
        id = fork.id;
      }
      for (const agent of originalManager.listAgents()) await originalManager.closeAgent(agent.id);
      await originalManager.flush();
      const persisted = (await storage.get(id))!;
      if (replay === "no handle") await storage.upsert({ ...persisted, persistence: undefined });
      const filesBefore = await readStoredFiles(agentsDir);
      expect(
        filesBefore
          .find(({ path }) => path.endsWith(`/${id}.timeline-prefix.json`))
          ?.bytes.toString(),
      ).toContain("src/parser.ts");
      const summarize = async () => {
        const { entries } = await summarizeWorkspaceAgents({
          workspaceId,
          agentManager: restartedManager,
          agentStorage: restartedStorage,
          workspaceRegistry,
          logger,
        });
        return entries.find(({ agentId }) => agentId === id);
      };
      const cold = await summarize();
      const expectedDetails = {
        firstUserPrompt: "Add a parser",
        lastAssistantSummary: replay === "available" ? "Empty input covered" : "Parser added",
        touchedFiles:
          replay === "available" ? ["src/parser.ts", "src/parser.test.ts"] : ["src/parser.ts"],
      };
      expect.soft(cold).toMatchObject(expectedDetails);
      const expectedUserMessages =
        replay === "available" ? [firstPrompt, repeatedPrompt, followup[0]] : [firstPrompt];
      const coldItems = await restartedManager.readTimelineForSummary(id, workspaceId);
      expect
        .soft(coldItems?.filter(({ type }) => type === "user_message"))
        .toEqual(expectedUserMessages);
      expect(historyReads).toEqual(
        replay === "no handle"
          ? []
          : [
              { purpose: "history", closes: 1 },
              { purpose: "history", closes: 1 },
            ],
      );
      expect(restartedManager.listAgents()).toEqual([]);
      expect(events).toEqual([]);
      expect(createdProviders).toEqual([]);
      expect(startedTurns).toEqual([]);
      expect(await readStoredFiles(agentsDir)).toEqual(filesBefore);

      const openChat = ensureAgentLoaded(id, {
        agentManager: restartedManager,
        agentStorage: restartedStorage,
        logger,
        purpose: "history",
      });
      if (replay === "failed") {
        await expect(openChat).rejects.toThrow("Provider history is unavailable");
        expect(restartedManager.getAgent(id)).not.toBeNull();
      } else {
        await openChat;
        expect(
          restartedManager.getTimeline(id).filter(({ type }) => type === "user_message"),
        ).toEqual(expectedUserMessages);
      }
      const warmed = await summarize();
      expect(warmed).toMatchObject(expectedDetails);
      expect(cold).toMatchObject({
        firstUserPrompt: warmed?.firstUserPrompt,
        lastAssistantSummary: warmed?.lastAssistantSummary,
        touchedFiles: warmed?.touchedFiles,
      });
      expect(historyReads).toHaveLength(replay === "no handle" ? 0 : 3);
    } finally {
      unsubscribe();
      for (const manager of [originalManager, restartedManager]) {
        await Promise.all(manager.listAgents().map(({ id }) => manager.closeAgent(id)));
        await manager.flush();
      }
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test.each(["active", "archived", "absent"])(
  "distinguishes children of an independent root when Main Control is %s",
  async (mainState) => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "wks_1234567890abcdef",
      projectId: "prj_1234567890abcdef",
      cwd: "/workspace",
      kind: "directory",
      displayName: "Summary workspace",
      createdAt,
      updatedAt: createdAt,
    });
    const base: Omit<StoredAgentRecord, "id"> = {
      provider: "codex",
      cwd: workspace.cwd,
      workspaceId: workspace.workspaceId,
      labels: {},
      metadata: {},
      createdAt,
      updatedAt: createdAt,
      lastStatus: "closed",
    };
    const records: StoredAgentRecord[] = [
      { ...base, id: "root" },
      { ...base, id: "child", labels: { [PARENT_AGENT_ID_LABEL]: "root" } },
      { ...base, id: "delegated", labels: { [PARENT_AGENT_ID_LABEL]: "main" } },
    ];
    if (mainState !== "absent") {
      records.push({
        ...base,
        id: "main",
        labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
        ...(mainState === "archived" ? { archivedAt: createdAt } : {}),
      });
    }
    const { entries, summaryText } = await summarizeWorkspaceAgents({
      workspaceId: workspace.workspaceId,
      agentManager: { listAgents: () => [], readTimelineForSummary: async () => [] },
      agentStorage: { listByWorkspaces: async () => records },
      workspaceRegistry: { get: async () => workspace },
      logger: pino({ level: "silent" }),
    });
    expect(
      entries.map(({ agentId, parentAgentId, relationship }) => [
        agentId,
        parentAgentId,
        relationship,
      ]),
    ).toEqual([
      ["child", "root", "standalone"],
      ["delegated", "main", mainState === "active" ? "level1" : "standalone"],
      ["root", null, "standalone"],
    ]);
    expect(summaryText).toContain(
      "- ID: child\n- Relationship: outside Main Control tree (parent: root)",
    );
  },
);
