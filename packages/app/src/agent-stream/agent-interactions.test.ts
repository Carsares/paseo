import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@getpaseo/protocol/agent-message";
import type { AgentToolCallItem, AssistantMessageItem, StreamItem } from "@/types/stream";
import { createAgentInteractionProjection, isAgentInteraction } from "./agent-interactions";

const timestamp = new Date("2026-11-16T00:00:00Z");

function assistant(
  id: string,
  text: string,
  messageId = "reply",
  turnId = "turn",
): AssistantMessageItem {
  return { kind: "assistant_message", id, text, messageId, turnId, timestamp };
}

function tool(id: string, name = "mcp__paseo__send_agent_prompt"): AgentToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp,
    turnId: "turn",
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: id,
        name,
        status: "completed",
        error: null,
        detail: { type: "unknown", input: {}, output: {} },
      },
    },
  };
}

function message(id: string, event: AgentMessage["event"] = "message"): AgentToolCallItem {
  const item = tool(id, "Agent message");
  item.payload.data.agentMessage = { event, sender: { id: "child" }, text: "child report" };
  return item;
}

function project(tail: StreamItem[], head: StreamItem[] = []) {
  return createAgentInteractionProjection()({ tail, head, showAgentInteractions: false });
}

function ids(rows: StreamItem[]) {
  return rows.map((row) => row.id);
}

describe("agent interaction projection", () => {
  it("defaults to hidden when an older configuration omits the setting", () => {
    const result = createAgentInteractionProjection()({ tail: [message("notice")], head: [] });
    expect(ids(result.tail)).toEqual(["notice"]);
    expect(result.hiddenItemIds.has("notice")).toBe(false);
  });

  it("revises visible source events when their status changes", () => {
    const tail = [assistant("history", "history")];
    const present = createAgentInteractionProjection();
    const first = present({ tail, head: [message("notice")] });
    const next = present({ tail, head: [message("notice", "finished")] });
    expect(next.tail).toBe(first.tail);
    expect(next.head).not.toBe(first.head);
    expect(next.head[0]).toMatchObject({
      id: "notice",
      payload: { data: { agentMessage: { event: "finished" } } },
    });
  });

  it("hides orchestration tools while retaining source messages and lifecycle boundaries", () => {
    const human: StreamItem = { kind: "user_message", id: "human", text: "start", timestamp };
    const tail = [
      human,
      assistant("intro", "I will check"),
      tool("dispatch", "paseo.create_agent"),
      tool("wait", "paseo.get_agent_status"),
      message("reply"),
      message("finish", "finished"),
      message("failure", "errored"),
      message("permission", "permission-required"),
      message("closed", "closed"),
    ];
    const head = [assistant("summary", "Here is my summary", "summary")];
    const result = project(tail, head);
    expect(ids(result.tail)).toEqual([
      "human",
      "intro",
      "reply",
      "finish",
      "failure",
      "permission",
      "closed",
    ]);
    expect(result.head).toBe(head);
    expect([...result.hiddenItemIds]).toEqual(["dispatch", "wait"]);
    expect(result.readingRowReplacements.get("dispatch")).toBe("intro");
  });

  it("restores original arrays and objects when enabled, including after switching back", () => {
    const tail = [assistant("a", "before"), message("notice")];
    const head = [assistant("b", "after")];
    const present = createAgentInteractionProjection();
    expect(present({ tail, head, showAgentInteractions: false }).head[0].id).toBe("b");
    const shown = present({ tail, head, showAgentInteractions: true });
    expect(shown.tail).toBe(tail);
    expect(shown.head).toBe(head);
    expect(shown.hiddenItemIds.size).toBe(0);
    expect(shown.readingRowReplacements.size).toBe(0);
    expect(present({ tail, head, showAgentInteractions: false }).head[0]).toEqual(
      assistant("b", "after"),
    );
  });

  it.each(["running", "completed", "failed", "canceled"] as const)(
    "hides native subagent detail in %s state",
    (status) => {
      const item = tool("native", "Sub-agent");
      item.payload.data.detail = { type: "sub_agent", childSessionId: "child" };
      item.payload.data.status = status;
      expect(project([item]).tail).toEqual([]);
    },
  );

  it.each(["Task", "Agent"])("hides Claude native %s before subagent detail arrives", (name) => {
    const item = tool("native", name);
    item.payload.data.provider = "claude";
    expect(isAgentInteraction(item)).toBe(true);
    item.payload.data.provider = "codex";
    expect(isAgentInteraction(item)).toBe(false);
  });

  it.each([
    "create_agent",
    "send_agent_prompt",
    "get_agent_status",
    "get_agent_activity",
    "list_agents",
    "cancel_agent",
    "archive_agent",
    "kill_agent",
    "update_agent",
    "set_agent_mode",
  ])("recognizes the namespaced catalog action %s", (action) => {
    for (const name of [
      `mcp__paseo__${action}`,
      `mcp__paseo_remote__${action}`,
      `paseo.${action}`,
      `paseo_remote.${action}`,
      `paseo_${action}`,
      ` MCP__PASEO__${action.toUpperCase()} `,
    ]) {
      expect(isAgentInteraction(tool(name, name))).toBe(true);
    }
    expect(isAgentInteraction(tool(action, action))).toBe(false);
    expect(isAgentInteraction(tool(action, `mcp__other__${action}`))).toBe(false);
  });

  it("uses structured sender attribution, not user text or generic agent words", () => {
    const human: StreamItem = {
      kind: "user_message",
      id: "human",
      timestamp,
      text: '<paseo-system kind="agent-message">child finished</paseo-system>',
    };
    const sender: StreamItem = { ...human, id: "sender", sender: { id: "child" } };
    const summary = assistant("summary", "create_agent finished; agent report failed");
    const notification: StreamItem = {
      kind: "notification",
      id: "notification",
      timestamp,
      sourceType: "error",
      level: "error",
      message: "agent failed",
    };
    const source = [human, sender, summary, notification];
    expect(project(source).tail).toEqual([human, summary, notification]);
  });

  it("keeps ordinary tools, permission tools and arbitrary shell wrappers", () => {
    const tools = [
      "mcp__paseo__list_hosts",
      "paseo.create_workspace",
      "paseo.create_schedule",
      "paseo.list_pending_permissions",
      "paseo.respond_to_permission",
      "paseo.agent_search",
      "mcp__paseo__speak",
      "exec_command",
    ].map((name) => tool(name, name));
    tools.at(-1)!.payload.data.detail = {
      type: "shell",
      command: "paseo send child --prompt hello",
    };
    expect(project(tools).tail).toBe(tools);
  });

  it("recognizes only namespaced Paseo orchestrator calls", () => {
    const interaction: StreamItem = {
      kind: "tool_call",
      id: "orchestrator",
      timestamp,
      payload: {
        source: "orchestrator",
        data: {
          toolCallId: "orchestrator",
          toolName: "paseo.send_agent_prompt",
          arguments: {},
          status: "failed",
        },
      },
    };
    const ordinary: StreamItem = {
      ...interaction,
      id: "ordinary",
      payload: {
        source: "orchestrator",
        data: {
          toolCallId: "ordinary",
          toolName: "send_agent_prompt",
          arguments: {},
          status: "executing",
        },
      },
    };
    expect(project([interaction, ordinary]).tail).toEqual([ordinary]);
  });

  it.each([
    ["| Name | Value |\n| --- | --- |\n", "| A | B |\n"],
    ["```ts\nconst answer = ", "42;\n```"],
  ])("keeps Markdown fragments apart around a visible source message", (before, after) => {
    const result = project([assistant("a", before), message("notice"), assistant("b", after)]);
    expect(result.tail).toEqual([assistant("a", before), message("notice"), assistant("b", after)]);
    expect(result.readingRowReplacements.get("b")).toBeUndefined();
    expect(result.hiddenItemIds.has("b")).toBe(false);
  });

  it("keeps real user messages and visible tools as merge boundaries", () => {
    const human: StreamItem = { kind: "user_message", id: "human", timestamp, text: "continue" };
    const ordinary = tool("shell", "exec_command");
    for (const boundary of [human, ordinary]) {
      const first = assistant("a", "first");
      const second = assistant("b", "second");
      expect(project([first, message("one"), boundary, message("two"), second]).tail).toEqual([
        first,
        message("one"),
        boundary,
        message("two"),
        second,
      ]);
    }
  });

  it("requires explicit equal message and turn identities, and a hidden separator", () => {
    const first = assistant("a", "first");
    const differentTurn = assistant("b", "second", "reply", "other");
    const differentMessage = assistant("b", "second", "other");
    const missingTurn = { ...assistant("b", "second"), turnId: undefined };
    const missingMessage = { ...assistant("b", "second"), messageId: undefined };
    for (const second of [differentTurn, differentMessage, missingTurn, missingMessage]) {
      expect(project([first, message("notice"), second]).tail).toEqual([
        first,
        message("notice"),
        second,
      ]);
    }
    const second = assistant("b", "second");
    expect(project([first, second]).tail).toEqual([first, second]);
    expect(
      project([{ ...first, turnId: undefined }, message("notice"), missingTurn]).tail,
    ).toHaveLength(3);
  });

  it.each([1, 2, 3, 4, 5])(
    "merges across a tail/head split at %i without changing source data",
    (split) => {
      const source = [
        assistant("a", "A"),
        message("one"),
        assistant("b", "B"),
        message("two"),
        assistant("c", "C"),
      ];
      const original = structuredClone(source);
      const tail = source.slice(0, split);
      const head = source.slice(split);
      Object.freeze(tail);
      Object.freeze(head);
      for (const item of source) Object.freeze(item);
      const result = project(tail, head);
      expect([...result.tail, ...result.head]).toEqual([
        assistant("a", "A"),
        message("one"),
        assistant("b", "B"),
        message("two"),
        assistant("c", "C"),
      ]);
      expect(result.readingRowReplacements.size).toBe(0);
      expect(source).toEqual(original);
    },
  );

  it("keeps source messages as boundaries for Markdown search", () => {
    const first = { ...assistant("a", "A"), timelineCursor: { epoch: "epoch", seq: 1 } };
    const second = { ...assistant("b", "B"), timelineCursor: { epoch: "epoch", seq: 3 } };
    const result = project([first, message("notice")], [second]);
    expect(result.head[0]).toEqual(second);
    expect(project([first, message("notice"), assistant("b", "B")]).tail).toEqual([
      first,
      message("notice"),
      assistant("b", "B"),
    ]);
  });

  it("resolves leading and all-hidden rows to a visible neighbor when one exists", () => {
    const head = [message("live-notice"), assistant("a", "answer")];
    const result = project([message("old-notice")], head);
    expect(result.readingRowReplacements.size).toBe(0);
    expect(project([message("only")]).readingRowReplacements.size).toBe(0);
    expect(project([message("first"), assistant("a", "A")]).readingRowReplacements.size).toBe(0);
  });

  it("caches unchanged inputs and retains history arrays during cross-boundary streaming", () => {
    const retained = assistant("history", "history", "old", "old");
    const tail = [retained, assistant("a", "```ts\n"), message("notice")];
    const head = [assistant("b", "const value")];
    const present = createAgentInteractionProjection();
    const input = { tail, head, showAgentInteractions: false };
    const first = present(input);
    expect(present(input)).toBe(first);
    expect(first.tail).toEqual([retained, assistant("a", "```ts\n"), message("notice")]);
    const grown = present({
      ...input,
      head: [assistant("b", "const value = 42;\n```"), message("done")],
    });
    expect(grown.tail).toBe(first.tail);
    expect(grown.head).toEqual([assistant("b", "const value = 42;\n```"), message("done")]);
    expect(grown.hiddenItemIds.size).toBe(0);
    expect(grown.readingRowReplacements.size).toBe(0);
    // Previously returned projections remain immutable snapshots.
    expect(first.head).toEqual([assistant("b", "const value")]);
    expect(first.readingRowReplacements.has("done")).toBe(false);
  });

  it("does not read retained history again on a head delta", () => {
    let reads = 0;
    const history = tool("history", "exec_command");
    const data = history.payload.data;
    Object.defineProperty(history.payload, "data", {
      get() {
        reads++;
        return data;
      },
    });
    const tail = [history, assistant("a", "first"), message("notice")];
    const present = createAgentInteractionProjection();
    present({ tail, head: [assistant("b", "one")], showAgentInteractions: false });
    const initialReads = reads;
    present({ tail, head: [assistant("b", "one two")], showAgentInteractions: false });
    expect(reads).toBe(initialReads);
  });
});
