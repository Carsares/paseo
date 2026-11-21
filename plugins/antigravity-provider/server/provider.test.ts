import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ProviderEvent, ProviderPersistence } from "@getpaseo/plugin/server/provider";
import { afterEach, describe, expect, it } from "vitest";
import { createAntigravityProvider } from "./provider.js";

const directories: string[] = [];
const historyConnections: Awaited<
  ReturnType<ReturnType<typeof createAntigravityProvider>["connect"]>
>[] = [];

afterEach(async () => {
  await Promise.all(historyConnections.splice(0).map((connection) => connection.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function launchAgent(source: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-acp-"));
  directories.push(directory);
  const executable = path.join(directory, "agy.cjs");
  await writeFile(executable, source);
  return {
    directory,
    launch: {
      command: process.execPath,
      args: [executable, "acp", "--disable-telemetry"],
      env: { CAPTURE: path.join(directory, "requests.ndjson") },
    },
  };
}

it("reports a CLI without the acp subcommand as unavailable", async () => {
  const { launch } = await launchAgent(`
    process.stderr.write("Unknown command: acp");
    process.exitCode = 1;
  `);
  const provider = createAntigravityProvider();
  expect(provider.command?.slice(0, 2)).toEqual(["agy", "acp"]);
  expect(await provider.status!({ launch })).toMatchObject({
    available: false,
    diagnostic: expect.stringContaining("1.5.0"),
  });
});

it.each([true, false])(
  "loads a saved stream-JSON session with ACP system prompt support %s",
  async (supportsSystemPrompt) => {
    const { directory, launch } = await launchAgent(`
      const { appendFileSync } = require("node:fs");
      const { createInterface } = require("node:readline");
      const configOptions = [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-4-neon",
          options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }, { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "gemini-4-neon-high", name: "Gemini 4 Neon High" }] },
        { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "low",
          options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
        { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "accept-edits",
          options: [{ value: "default", name: "Default" }, { value: "accept-edits", name: "Accept edits" }] },
      ];
      const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
      createInterface({ input: process.stdin }).on("line", (line) => {
        appendFileSync(process.env.CAPTURE, line + "\\n");
        const { id, method, params } = JSON.parse(line);
        switch (method) {
          case "initialize":
            send({ id, result: { protocolVersion: 1, agentCapabilities: {
              loadSession: true,
              _meta: { antigravity: { systemPrompt: { append: ${supportsSystemPrompt} } } },
            } } });
            break;
          case "session/load":
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Saved reply" },
            } } });
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "tool_call", toolCallId: "write", name: "write_file", title: "File notes.txt",
              status: "completed", kind: "edit", rawInput: { Path: "/repo/notes.txt", Content: "hello" },
            } } });
            send({ id, result: { configOptions } });
            break;
          case "session/set_config_option":
            configOptions.find(option => option.id === params.configId).currentValue = params.value;
            send({ id, result: { configOptions } });
            break;
          case "session/close":
            send({ id, result: {} });
            break;
        }
      });
    `);
    const provider = createAntigravityProvider();
    expect(await provider.status!({ launch })).toEqual({ available: true });
    const connection = await provider.connect({
      launch,
      versions: [1],
      capabilities: ["session.configure", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        type: "session.open",
        requestId: "restore",
        sessionId: "test",
        history: "replay",
        persistence: { version: 1, data: { conversationId: "saved-conversation" } },
        config: {
          cwd: directory,
          model: "gemini-3.8-flash-high",
          mode: "full-access",
          systemPrompt: "A test system instruction",
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await expect
        .poll(
          () =>
            events.find(
              (event) => event.type === "session.ready" || event.type === "request.failed",
            ),
          { timeout: 3_000 },
        )
        .toMatchObject({ type: "session.ready" });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.opened",
          persistence: { version: 1, data: { sessionId: "saved-conversation" } },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({ type: "assistant_message", text: "Saved reply" }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.config",
          config: expect.objectContaining({
            mode: "full-access",
            modes: expect.arrayContaining([
              expect.objectContaining({ id: "full-access", isUnattended: true }),
            ]),
            model: "gemini-3.8-flash",
            thinkingOption: "high",
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({
            type: "tool_call",
            detail: { type: "write", filePath: "/repo/notes.txt", content: "hello" },
          }),
        }),
      );
      await connection.send({
        type: "session.configure",
        requestId: "native-model",
        sessionId: "test",
        changes: { model: "gemini-4-neon-high" },
      });
      await expect
        .poll(() =>
          events.find(
            (event) =>
              event.type === "session.config" && event.config.model === "gemini-4-neon-high",
          ),
        )
        .toBeDefined();
      const requests = (await readFile(launch.env.CAPTURE, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const load = requests.find((request) => request.method === "session/load");
      expect(load.params.sessionId).toBe("saved-conversation");
      expect(load.params._meta.antigravity).toEqual(
        supportsSystemPrompt
          ? { systemPrompt: { append: "A test system instruction" } }
          : undefined,
      );
    } finally {
      await connection.close();
    }
  },
);

describe("installation", () => {
  const signal = new AbortController().signal;

  it("reports the version agy prints and links its install docs", async () => {
    // A real `agy acp --version` starts the ACP server, so the fake refuses it.
    const { launch } = await launchAgent(`
      const args = process.argv.slice(2);
      if (args.includes("acp")) process.exit(1);
      if (args[0] === "--version") console.log("Antigravity CLI 1.6.2");
    `);
    const installation = createAntigravityProvider().installation!;
    expect(installation.installUrl).toBe("https://antigravity.google/docs/getting-started?tab=cli");
    expect(installation.update).toBeUndefined();
    await expect(
      installation.inspect!({ launch: { ...launch, resolved: true }, signal }),
    ).resolves.toEqual({
      status: "installed",
      version: "1.6.2",
    });
  });

  it("is not installed when the executable does not resolve", async () => {
    const launch = { command: "agy", args: ["acp"], env: {}, resolved: false };
    await expect(
      createAntigravityProvider().installation!.inspect!({ launch, signal }),
    ).resolves.toEqual({ status: "not_installed" });
  });
});

it("keeps a turn open for backgrounded run_command calls but not IsDaemon commands", async () => {
  const { directory, launch } = await launchAgent(`
    const { createInterface } = require("node:readline");
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    let turn = 0;
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      switch (method) {
        case "initialize":
          send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
          break;
        case "session/new":
          send({ id, result: { sessionId: "agy-session", configOptions: [
            { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
              options: [{ value: "default", name: "Default" }] },
          ] } });
          break;
        case "session/prompt":
          turn += 1;
          if (turn === 1) {
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "tool_call", toolCallId: "daemon-1", name: "run_command",
              title: "Dev server", status: "in_progress", rawInput: { CommandLine: "npm run dev", IsDaemon: true },
            } } });
            send({ id, result: { stopReason: "end_turn" } });
          } else {
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "tool_call", toolCallId: "bg-1", name: "run_command",
              title: "Background build", status: "in_progress", rawInput: { CommandLine: "sleep 1" },
            } } });
            send({ id, result: { stopReason: "end_turn" } });
            setTimeout(() => {
              send({ method: "session/update", params: { sessionId: params.sessionId, update: {
                sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "completed",
              } } });
              send({ method: "session/update", params: { sessionId: params.sessionId, update: {
                sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Build finished." },
              } } });
              send({ method: "session/update", params: { sessionId: params.sessionId, update: {
                sessionUpdate: "usage_update", used: 50, size: 1000,
              } } });
            }, 80);
          }
          break;
        case "session/close":
          send({ id, result: {} });
          break;
      }
    });
  `);
  const provider = createAntigravityProvider();
  const connection = await provider.connect({
    launch,
    versions: [1],
    capabilities: ["prompt.message"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "agy-test",
      history: "skip",
      config: {
        cwd: directory,
        env: {},
        mcpServers: {},
        settings: {},
        persist: false,
      },
    });
    await expect
      .poll(() => events.find((event) => event.type === "session.ready"), { timeout: 3_000 })
      .toBeDefined();

    // Turn 1: IsDaemon: true completes immediately on end_turn.
    await connection.send({
      type: "session.prompt",
      sessionId: "agy-test",
      prompt: {
        clientMessageId: "daemon-turn",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "start dev server" }] },
      },
    });
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "session.turn" &&
              event.turnId === "acp:daemon-turn" &&
              event.state === "completed",
          ),
        { timeout: 3_000 },
      )
      .toBeDefined();

    // Turn 2: non-daemon background command keeps turn open until completion + reply + usage_update.
    await connection.send({
      type: "session.prompt",
      sessionId: "agy-test",
      prompt: {
        clientMessageId: "bg-turn",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "run build" }] },
      },
    });
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "timeline.item" &&
              event.item.type === "tool_call" &&
              event.item.id === "bg-1" &&
              event.item.status === "running",
          ),
        { timeout: 3_000 },
      )
      .toBeDefined();
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:bg-turn" &&
          event.state === "completed",
      ),
    ).toBe(false);
    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.type === "session.turn" &&
              event.turnId === "acp:bg-turn" &&
              event.state === "completed",
          ),
        { timeout: 3_000 },
      )
      .toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "assistant_message", text: "Build finished." }),
      }),
    );
  } finally {
    await connection.close();
  }
});

async function historyHarness(protocolReplay = false) {
  const { directory: cwd, launch } = await launchAgent(`
    const { createInterface } = require("node:readline");
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      if (method === "initialize") {
        send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      } else if (method === "session/load") {
        send({ id, result: { modes: {
          currentModeId: "default", availableModes: [{ id: "default", name: "Default" }],
        } } });
        setTimeout(() => {
          const update = (data) => send({
            method: "session/update", params: { sessionId: params.sessionId, update: data },
          });
          update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          if (${protocolReplay}) {
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Saved reply" } });
          }
        }, 35);
      } else if (method === "session/close") {
        send({ id, result: {} });
      }
    });
  `);
  const connection = await createAntigravityProvider().connect({
    launch: { ...launch, env: { ...launch.env, HOME: cwd, USERPROFILE: cwd } },
    versions: [1],
    capabilities: ["session.persistence"],
  });
  historyConnections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  return {
    cwd,
    events,
    async open(
      persistence: ProviderPersistence,
      sessionId = "s",
      history: "replay" | "skip" = "replay",
    ) {
      await connection.send({
        type: "session.open",
        requestId: sessionId,
        sessionId,
        persistence,
        history,
        config: {
          cwd,
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
          systemPrompt: "SYSTEM PREFIX",
        },
      });
      await expect
        .poll(
          () =>
            events.find(
              (event) =>
                "requestId" in event &&
                event.requestId === sessionId &&
                (event.type === "session.ready" || event.type === "request.failed"),
            ),
          { timeout: 3_000 },
        )
        .toMatchObject({ type: "session.ready" });
    },
  };
}

it("replays local transcript history before session.ready on resume and skips replay when requested", async () => {
  const conversationId = "e5cf1e2d-c715-4328-8e67-4a85c8dc3cda";
  const persistence: ProviderPersistence = { version: 1, data: { conversationId } };
  const h = await historyHarness();
  const logsDir = path.join(
    h.cwd,
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
  );
  await mkdir(logsDir, { recursive: true });
  const steps = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-11-20T15:18:52Z",
      content: [
        "<USER_REQUEST>",
        "SYSTEM PREFIX",
        "",
        "Inspect docs/design.md and explain </USER_REQUEST> handling.",
        "Attached image: /tmp/paseo-antigravity-images-abc123/shot.png",
        "</USER_REQUEST>",
        "<ADDITIONAL_METADATA>",
        "The current local time is: 2026-11-20T23:18:52+08:00.",
        "</ADDITIONAL_METADATA>",
        "<USER_SETTINGS_CHANGE>",
        "Model changed.",
        "</USER_SETTINGS_CHANGE>",
      ].join("\n"),
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-20T15:18:55Z",
      thinking: "Checking design docs and running a shell check.\n",
      tool_calls: [
        {
          name: "read_file",
          args: { Path: "/repo/docs/design.md", StartLine: 10, EndLine: 29 },
        },
        {
          name: "edit_file",
          args: { Path: "/repo/src/a.ts", Target: "oldVal", Replacement: "newVal" },
        },
        {
          name: "run_command",
          args: { CommandLine: "npm test", Cwd: "/repo" },
        },
        {
          name: "invoke_subagent",
          args: { TypeName: "research", Prompt: "Survey icons" },
        },
      ],
    },
    {
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-20T15:18:56Z",
      content:
        "Created At: 2026-11-20T23:18:56+08:00\nCompleted At: 2026-11-20T23:18:57+08:00\n10: token rules",
    },
    {
      step_index: 3,
      source: "MODEL",
      type: "GENERIC",
      status: "ERROR",
      error: "Target not found",
      created_at: "2026-11-20T15:18:57Z",
      content: "Created At: 2026-11-20T23:18:57+08:00\nEncountered error: Target not found",
    },
    {
      step_index: 4,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-20T15:18:58Z",
      content:
        "Created At: 2026-11-20T23:18:58+08:00\nCompleted At: 2026-11-20T23:18:59+08:00\nCommand exited with code 1.\n\nFAIL test",
    },
    {
      step_index: 5,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-20T15:19:00Z",
      content: [
        "Created At: 2026-11-20T23:19:00+08:00",
        "Created the following subagent:",
        "{",
        '  "conversationId": "child-conv-1",',
        '  "logAbsoluteUri": "file:///tmp/child.jsonl"',
        "}",
      ].join("\n"),
    },
    {
      step_index: 6,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-20T15:19:05Z",
      content: "Here is the summary.",
    },
    {
      step_index: 7,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-11-20T15:20:00Z",
      content:
        "<USER_REQUEST>\nAttached image: /tmp/paseo-antigravity-images-abc123/only.webp\n</USER_REQUEST>",
    },
    {
      step_index: 8,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-20T15:20:02Z",
      tool_calls: [{ name: "write_file", args: { Path: "/repo/out.md", Content: "# Out" } }],
    },
  ];
  await writeFile(
    path.join(logsDir, "transcript_full.jsonl"),
    `${steps.map((step) => JSON.stringify(step)).join("\n")}\n`,
  );

  await h.open(persistence);
  const openedIdx = h.events.findIndex((event) => event.type === "session.opened");
  const readyIdx = h.events.findIndex((event) => event.type === "session.ready");
  const timelineIndices = h.events
    .map((event, idx) => (event.type === "timeline.item" ? idx : -1))
    .filter((idx) => idx >= 0);
  expect(timelineIndices.length).toBe(9);
  expect(timelineIndices.every((idx) => idx > openedIdx && idx < readyIdx)).toBe(true);

  const replayed = h.events.filter((event) => event.type === "timeline.item");
  expect(replayed).toEqual([
    {
      type: "timeline.item",
      sessionId: "s",
      timestamp: "2026-11-20T15:18:52Z",
      item: {
        type: "user_message",
        id: "history:user:0",
        messageId: "history:user:0",
        text: "Inspect docs/design.md and explain </USER_REQUEST> handling.",
      },
    },
    {
      type: "timeline.item",
      sessionId: "s",
      timestamp: "2026-11-20T15:18:55Z",
      item: {
        type: "reasoning",
        id: "history:reasoning:1",
        text: "Checking design docs and running a shell check.",
      },
    },
    {
      type: "timeline.item",
      sessionId: "s",
      timestamp: "2026-11-20T15:18:56Z",
      item: {
        type: "tool_call",
        id: "history:tool:1:0",
        callId: "history:tool:1:0",
        name: "read_file",
        status: "completed",
        error: null,
        detail: {
          type: "read",
          filePath: "/repo/docs/design.md",
          content: "10: token rules",
          offset: 10,
          limit: 20,
        },
      },
    },
    {
      type: "timeline.item",
      sessionId: "s",
      timestamp: "2026-11-20T15:18:57Z",
      item: {
        type: "tool_call",
        id: "history:tool:1:1",
        callId: "history:tool:1:1",
        name: "edit_file",
        status: "failed",
        error: "Target not found",
        detail: {
          type: "edit",
          filePath: "/repo/src/a.ts",
          oldString: "oldVal",
          newString: "newVal",
        },
      },
    },
    {
      type: "timeline.item",
      sessionId: "s",
      timestamp: "2026-11-20T15:18:58Z",
      item: {
        type: "tool_call",
        id: "history:tool:1:2",
        callId: "history:tool:1:2",
        name: "run_command",
        status: "failed",
        error: "Command exited with code 1",
        detail: {
          type: "shell",
          command: "npm test",
          cwd: "/repo",
          output: "Command exited with code 1.\n\nFAIL test",
          exitCode: 1,
        },
      },
    },
    {
      type: "timeline.item",
      sessionId: "s",
      timestamp: "2026-11-20T15:19:00Z",
      item: {
        type: "tool_call",
        id: "history:tool:1:3",
        callId: "history:tool:1:3",
        name: "invoke_subagent",
        status: "completed",
        error: null,
        detail: {
          type: "sub_agent",
          subAgentType: "research",
          description: "Survey icons",
          childSessionId: "child-conv-1",
          log: "file:///tmp/child.jsonl",
        },
      },
    },
    {
      type: "timeline.item",
      sessionId: "s",
      timestamp: "2026-11-20T15:19:05Z",
      item: {
        type: "assistant_message",
        id: "history:assistant:6",
        messageId: "history:assistant:6",
        text: "Here is the summary.",
      },
    },
    {
      type: "timeline.item",
      sessionId: "s",
      timestamp: "2026-11-20T15:20:00Z",
      item: {
        type: "user_message",
        id: "history:user:7",
        messageId: "history:user:7",
        text: "[Attached image]",
      },
    },
    {
      type: "timeline.item",
      sessionId: "s",
      timestamp: "2026-11-20T15:20:02Z",
      item: {
        type: "tool_call",
        id: "history:tool:8:0",
        callId: "history:tool:8:0",
        name: "write_file",
        status: "canceled",
        error: null,
        detail: {
          type: "write",
          filePath: "/repo/out.md",
          content: "# Out",
        },
      },
    },
  ]);

  await h.open(persistence, "skip-session", "skip");
  expect(
    h.events.filter(
      (event) => event.type === "timeline.item" && event.sessionId === "skip-session",
    ),
  ).toEqual([]);
});

it("falls back to compact transcript.jsonl and decodes stringified tool arguments", async () => {
  const conversationId = "e5cf1e2d-c715-4328-8e67-4a85c8dc3cda";
  const persistence: ProviderPersistence = { version: 1, data: { conversationId } };
  const h = await historyHarness();
  const logsDir = path.join(
    h.cwd,
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
  );
  await mkdir(logsDir, { recursive: true });
  const compactSteps = [
    {
      step_index: 0,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-20T16:00:00Z",
      tool_calls: [
        {
          name: "read_file",
          args: {
            Path: JSON.stringify("/repo/README.md"),
            StartLine: "1",
            EndLine: "50",
          },
        },
      ],
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-20T16:00:01Z",
      content: "Created At: 2026-11-20T16:00:01Z\n1: # Readme",
    },
  ];
  await writeFile(
    path.join(logsDir, "transcript.jsonl"),
    `${compactSteps.map((step) => JSON.stringify(step)).join("\n")}\n`,
  );

  await h.open(persistence);
  expect(h.events.filter((event) => event.type === "timeline.item")).toEqual([
    {
      type: "timeline.item",
      sessionId: "s",
      timestamp: "2026-11-20T16:00:01Z",
      item: {
        type: "tool_call",
        id: "history:tool:0:0",
        callId: "history:tool:0:0",
        name: "read_file",
        status: "completed",
        error: null,
        detail: {
          type: "read",
          filePath: "/repo/README.md",
          content: "1: # Readme",
          offset: 1,
          limit: 50,
        },
      },
    },
  ]);
});

it("uses delayed protocol history once when the same saved reply is in the local transcript", async () => {
  const h = await historyHarness(true);
  const sessionId = "saved-conversation";
  const logsDir = path.join(
    h.cwd,
    ".gemini",
    "antigravity-cli",
    "brain",
    sessionId,
    ".system_generated",
    "logs",
  );
  await mkdir(logsDir, { recursive: true });
  await writeFile(
    path.join(logsDir, "transcript_full.jsonl"),
    JSON.stringify({
      step_index: 0,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "Saved reply",
    }) + "\n",
  );

  const persistence = { version: 1, data: { sessionId } };
  await h.open(persistence);
  const history = h.events.filter((event) => event.type === "timeline.item");
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ item: { type: "assistant_message", text: "Saved reply" } });
  expect(history[0].item.id).not.toBe("history:assistant:0");

  await h.open(persistence, "skip-session", "skip");
  expect(
    h.events.filter(
      (event) => event.type === "timeline.item" && event.sessionId === "skip-session",
    ),
  ).toEqual([]);
});
