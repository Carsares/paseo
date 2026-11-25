import { expect, test } from "vitest";
import type { SessionOutboundMessage } from "../messages.js";
import { SessionAuthorization } from "./index.js";

test("workspace deferral and delayed agent messages require their host write permissions", () => {
  const deferral = { type: "workspace.deferral.set.request" } as const;
  const recovery = { type: "agent.limit.recovery.request" } as const;
  const readOnly = new SessionAuthorization(["workspace.read"]);
  const manage = new SessionAuthorization(["workspace.manage"]);
  const write = new SessionAuthorization(["workspace.write"]);
  const hub = new SessionAuthorization(["hub.execute"]);
  expect(readOnly.allowsInbound(deferral)).toBe(false);
  expect(readOnly.allowsInbound(recovery)).toBe(false);
  expect(manage.allowsInbound(deferral)).toBe(true);
  expect(manage.allowsInbound(recovery)).toBe(false);
  expect(write.allowsInbound(recovery)).toBe(true);
  expect(write.allowsInbound(deferral)).toBe(false);
  expect(hub.allowsInbound(recovery)).toBe(false);
});

test("workspace task requests and replies require workspace read permission", () => {
  const request = { type: "workspace.tasks.list.request" } as const;
  const reply = {
    type: "workspace.tasks.list.response",
    payload: { requestId: "request-1", workspaceId: "workspace-1", tasks: [], error: null },
  } satisfies SessionOutboundMessage;
  const readOnly = new SessionAuthorization(["workspace.read"]);
  const writeOnly = new SessionAuthorization(["workspace.write"]);
  const hub = new SessionAuthorization(["hub.execute"]);

  expect(readOnly.allowsInbound(request)).toBe(true);
  expect(readOnly.allowsOutbound(reply)).toBe(true);
  expect(writeOnly.allowsInbound(request)).toBe(false);
  expect(writeOnly.allowsOutbound(reply)).toBe(false);
  expect(hub.allowsInbound(request)).toBe(false);
  expect(hub.allowsOutbound(reply)).toBe(false);
});

test("pending rewind file operations require workspace write for requests and replies", () => {
  const request = {
    type: "agent.rewind.checkpoint.get.request",
    requestId: "lookup",
    agentId: "agent",
    messageId: "",
    pendingFiles: true,
  } as const;
  const reply = {
    type: "agent.rewind.checkpoint.get.response",
    payload: {
      requestId: "lookup",
      agentId: "agent",
      ok: true,
      error: null,
      pendingFiles: [{ operationId: "operation", conversationRewound: true }],
    },
  } satisfies SessionOutboundMessage;
  const reader = new SessionAuthorization(["workspace.read"]);
  const writer = new SessionAuthorization(["workspace.write"]);
  expect(reader.allowsInbound(request)).toBe(false);
  expect(reader.allowsOutbound(reply)).toBe(false);
  expect(writer.allowsInbound(request)).toBe(true);
  expect(writer.allowsOutbound(reply)).toBe(true);
});

test.each([
  ["locate", "daemon.read"],
  ["test", "daemon.manage"],
  ["save", "daemon.manage"],
] as const)("custom CLI %s requires %s", (operation, permission) => {
  const request = { type: `provider.custom_cli.${operation}.request` } as const;
  const reply = {
    type: `provider.custom_cli.${operation}.response`,
    payload: { requestId: "request-1", result: { status: "ok" } },
  } satisfies SessionOutboundMessage;
  const readOnly = new SessionAuthorization(["daemon.read"]);
  const allowed = new SessionAuthorization([permission]);

  expect(readOnly.allowsInbound(request)).toBe(operation === "locate");
  expect(readOnly.allowsOutbound(reply)).toBe(operation === "locate");
  expect(allowed.allowsInbound(request)).toBe(true);
  expect(allowed.allowsOutbound(reply)).toBe(true);
});

test("host proxy settings use separate read and manage permissions", () => {
  const reader = new SessionAuthorization(["daemon.read"]);
  const manager = new SessionAuthorization(["daemon.manage"]);
  const unprivileged = new SessionAuthorization(["workspace.read"]);
  const request = {
    get: { type: "daemon.network.get_proxy.request" },
    test: { type: "daemon.network.test_proxy.request" },
    set: { type: "daemon.network.set_proxy.request" },
  } as const;
  expect(reader.allowsInbound(request.get)).toBe(true);
  expect(reader.allowsInbound(request.test)).toBe(false);
  expect(reader.allowsInbound(request.set)).toBe(false);
  expect(manager.allowsInbound(request.test)).toBe(true);
  expect(manager.allowsInbound(request.set)).toBe(true);
  expect(unprivileged.allowsInbound(request.get)).toBe(false);
  expect(
    unprivileged.allowsOutbound({
      type: "daemon.network.get_proxy.response",
      payload: { requestId: "settings", result: { status: "denied" } },
    }),
  ).toBe(true);
});

test.each([
  [
    "provider.installation.approved_update.request",
    {
      type: "provider.installation.approved_update.response",
      payload: { provider: "codex", requestId: "test", update: null, error: "unavailable" },
    },
  ],
  [
    "provider.catalog_pin.update.request",
    {
      type: "provider.catalog_pin.update.response",
      payload: { provider: "codex", requestId: "test", status: "updated" },
    },
  ],
] as const satisfies readonly (readonly [string, SessionOutboundMessage])[])(
  "%s requires daemon.manage",
  (type, reply) => {
    const reader = new SessionAuthorization(["daemon.read"]);
    const manager = new SessionAuthorization(["daemon.manage"]);
    expect(reader.allowsInbound({ type })).toBe(false);
    expect(reader.allowsOutbound(reply)).toBe(false);
    expect(manager.allowsInbound({ type })).toBe(true);
    expect(manager.allowsOutbound(reply)).toBe(true);
  },
);
