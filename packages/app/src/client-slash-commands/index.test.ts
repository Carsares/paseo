import { describe, expect, it } from "vitest";
import {
  CLIENT_SLASH_COMMANDS,
  availableClientSlashCommands,
  buildDraftAgentSetup,
  resolveClientSlashCommand,
} from "@/client-slash-commands";
import type { Agent } from "@/stores/session-store";

function createAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date("2026-05-15T00:00:00.000Z");
  return {
    serverId: "server-1",
    id: "agent-1",
    provider: "codex",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: now,
    lastActivityAt: now,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: "mode-current",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: "session-1",
      model: "runtime-model",
      modeId: "runtime-mode",
      thinkingOptionId: "runtime-thinking",
    },
    title: "Agent",
    cwd: "/repo",
    model: "agent-model",
    thinkingOptionId: "think-hard",
    options: { "web-search": true, effort: "high" },
    parentAgentId: null,
    labels: {},
    ...overrides,
    turn: overrides.turn ?? { phase: "idle", cancellationRequestId: null },
  };
}

describe("resolveClientSlashCommand", () => {
  it("declares the exact canonical client commands with their aliases", () => {
    expect(
      CLIENT_SLASH_COMMANDS.map((command) => [
        command.name,
        [...command.aliases],
        command.execution,
      ]),
    ).toEqual([
      ["exit", ["quit", "q"], "immediate"],
      ["clear", ["new"], "immediate"],
      ["side", ["btw"], "immediate"],
    ]);
  });

  it("resolves canonical names and aliases after trimming", () => {
    expect(resolveClientSlashCommand({ text: " /quit ", hasAttachments: false })).toMatchObject({
      name: "exit",
      kind: "archive-agent",
      execution: "immediate",
    });
    expect(resolveClientSlashCommand({ text: "/exit", hasAttachments: false })).toMatchObject({
      name: "exit",
      kind: "archive-agent",
    });
    expect(resolveClientSlashCommand({ text: "/q", hasAttachments: false })).toMatchObject({
      name: "exit",
      kind: "archive-agent",
    });
    expect(resolveClientSlashCommand({ text: "/clear", hasAttachments: false })).toMatchObject({
      name: "clear",
      kind: "replace-agent-with-draft",
    });
    expect(resolveClientSlashCommand({ text: "/new", hasAttachments: false })).toMatchObject({
      name: "clear",
      kind: "replace-agent-with-draft",
    });
  });

  it("leaves provider commands, arguments, ordinary messages, and attachment submits alone", () => {
    expect(resolveClientSlashCommand({ text: "/clear now", hasAttachments: false })).toBeNull();
    expect(resolveClientSlashCommand({ text: "/quit now", hasAttachments: false })).toBeNull();
    expect(
      resolveClientSlashCommand({ text: "/provider-command", hasAttachments: false }),
    ).toBeNull();
    expect(resolveClientSlashCommand({ text: "hello /quit", hasAttachments: false })).toBeNull();
    expect(resolveClientSlashCommand({ text: "/quit", hasAttachments: true })).toBeNull();
  });

  it("resolves a bare side chat and preserves the exact argument text", () => {
    const options = { allowSideChat: true, hasAttachments: false };
    expect(resolveClientSlashCommand({ ...options, text: "/side" })).toMatchObject({
      kind: "side-chat",
      argumentText: "",
    });
    expect(
      resolveClientSlashCommand({ ...options, text: "  /btw  a /clear   \n\tb\n" }),
    ).toMatchObject({ kind: "side-chat", argumentText: " a /clear   \n\tb\n" });
    for (const text of ["/side: text", "/btw/path", "say /btw", "/sidebar"]) {
      expect(resolveClientSlashCommand({ ...options, text })).toBeNull();
    }
    expect(
      resolveClientSlashCommand({ ...options, text: "/side", hasAttachments: true }),
    ).toBeNull();
    expect(
      resolveClientSlashCommand({ ...options, text: "/side", allowSideChat: false }),
    ).toBeNull();
  });

  it("keeps the available alias when a provider owns the other token", () => {
    const options = {
      allowSideChat: true,
      hasAttachments: false,
      providerCommands: [{ name: "side" }],
    };
    expect(
      availableClientSlashCommands(options).find(({ kind }) => kind === "side-chat"),
    ).toMatchObject({ name: "btw", aliases: [] });
    expect(resolveClientSlashCommand({ ...options, text: "/side provider args" })).toBeNull();
    expect(resolveClientSlashCommand({ ...options, text: "/btw my question" })).toMatchObject({
      kind: "side-chat",
      argumentText: "my question",
    });
    expect(
      availableClientSlashCommands({ ...options, pluginCommands: [{ name: "btw" }] }).some(
        ({ kind }) => kind === "side-chat",
      ),
    ).toBe(false);
  });
});

describe("buildDraftAgentSetup", () => {
  it("builds draft setup from the active agent snapshot", () => {
    expect(buildDraftAgentSetup(createAgent())).toEqual({
      provider: "codex",
      cwd: "/repo",
      modeId: "mode-current",
      model: "agent-model",
      thinkingOptionId: "think-hard",
      providerOptions: {
        "web-search": true,
        effort: "high",
      },
    });
  });

  it("falls back to runtime model setup when top-level fields are absent", () => {
    expect(
      buildDraftAgentSetup(
        createAgent({
          currentModeId: null,
          model: null,
          thinkingOptionId: null,
        }),
      ),
    ).toMatchObject({
      modeId: "runtime-mode",
      model: "runtime-model",
      thinkingOptionId: "runtime-thinking",
    });
  });
});
