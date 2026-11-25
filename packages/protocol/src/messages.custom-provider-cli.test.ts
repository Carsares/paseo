import { expect, test } from "vitest";
import { WSInboundMessageSchema, WSOutboundMessageSchema } from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

test.each(["locate", "test", "save"])("accepts custom CLI %s requests and replies", (operation) => {
  const requestId = "request-1";
  const request = {
    type: "session",
    message: {
      type: `provider.custom_cli.${operation}.request`,
      requestId,
      draft: {
        mode: "edit",
        providerId: "codex",
        command: ["my-cli", "two words"],
        env: { FLAG: "1" },
      },
    },
  };
  expect(WSInboundMessageSchema.parse(request)).toEqual(request);
  expect(
    WSInboundMessageSchema.safeParse({
      ...request,
      message: {
        ...request.message,
        draft: { mode: "edit", providerId: "codex", command: "my-cli --flag" },
      },
    }).success,
  ).toBe(false);

  for (const result of [
    { status: "ok", path: "/bin/my-cli" },
    { status: "blocked" },
    { status: "blocked", reason: "reload_required" },
    null,
  ]) {
    const reply = {
      type: "session",
      message: {
        type: `provider.custom_cli.${operation}.response`,
        payload: { requestId, result },
      },
    };
    expect(WSOutboundMessageSchema.parse(reply)).toEqual(reply);
    expect(validateWSOutboundMessage(reply)).toMatchObject({ success: true, data: reply });
  }
});

test("old clients and hosts can omit the custom CLI feature", () => {
  const hello = { type: "hello", clientId: "client-1", clientType: "cli", protocolVersion: 1 };
  expect(WSInboundMessageSchema.safeParse(hello).success).toBe(true);
  const hostInfo = {
    type: "session",
    message: {
      type: "status",
      payload: {
        status: "server_info",
        serverId: "srv-1",
        features: { providerInstallation: true },
      },
    },
  };
  expect(WSOutboundMessageSchema.safeParse(hostInfo).success).toBe(true);
  expect(validateWSOutboundMessage(hostInfo).success).toBe(true);
});

test.each([
  {
    operation: "installation.approved_update",
    request: { provider: "codex", planId: "local-plan-1" },
    response: { provider: "codex", update: null, error: "The update plan is unavailable." },
  },
  {
    operation: "catalog_pin.update",
    request: { provider: "gemini", expectedVersion: "0.60.0", version: "0.70.0" },
    response: { provider: "gemini", status: "updated" },
  },
])("accepts $operation and its correlated response", ({ operation, request, response }) => {
  const requestId = "request-2";
  const inbound = {
    type: "session",
    message: { type: `provider.${operation}.request`, requestId, ...request },
  };
  expect(WSInboundMessageSchema.parse(inbound)).toEqual(inbound);
  expect(
    WSInboundMessageSchema.parse({
      ...inbound,
      message: { ...inbound.message, command: ["/bin/false"] },
    }),
  ).toEqual(inbound);
  const outbound = {
    type: "session",
    message: { type: `provider.${operation}.response`, payload: { requestId, ...response } },
  };
  expect(WSOutboundMessageSchema.parse(outbound)).toEqual(outbound);
  expect(validateWSOutboundMessage(outbound)).toMatchObject({ success: true, data: outbound });
});
