import { describe, expect, test } from "vitest";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
} from "../messages.js";
import {
  DAEMON_PERMISSIONS,
  OWNER_PERMISSIONS,
  SessionAuthorization,
  permissionsForLegacyHubScopes,
  parseDaemonPermissions,
} from "./index.js";

function inboundOperationTypes(): SessionInboundMessage["type"][] {
  return SessionInboundMessageSchema.options.map((option) => option.shape.type.value);
}

function outboundOperationTypes(): SessionOutboundMessage["type"][] {
  return SessionOutboundMessageSchema.options.map((option) => option.shape.type.value);
}

function inboundMessage(type: SessionInboundMessage["type"]): SessionInboundMessage {
  return { type } as SessionInboundMessage;
}

function outboundMessage(type: SessionOutboundMessage["type"]): SessionOutboundMessage {
  if (type === "status")
    return {
      type,
      payload: { status: "agent_create_failed", error: "test", requestId: "test" },
    } as SessionOutboundMessage;
  return { type } as SessionOutboundMessage;
}

describe("SessionAuthorization", () => {
  test("resident creation and reset require both workspace and Hub execution authority", () => {
    const writeOnly = new SessionAuthorization(["workspace.write"]);
    const hubOnly = new SessionAuthorization(["hub.execute"]);
    const both = new SessionAuthorization(["workspace.write", "hub.execute"]);
    for (const [request, response] of [
      ["agent.resident.create.request", "agent.resident.create.response"],
      ["agent.session.reset.request", "agent.session.reset.response"],
    ] as const) {
      for (const authorization of [writeOnly, hubOnly]) {
        expect(authorization.allowsInbound(inboundMessage(request))).toBe(false);
        expect(authorization.allowsOutbound(outboundMessage(response))).toBe(false);
      }
      expect(both.allowsInbound(inboundMessage(request))).toBe(true);
      expect(both.allowsOutbound(outboundMessage(response))).toBe(true);
    }
    expect(writeOnly.allowsInbound(inboundMessage("agent.resident.set.request"))).toBe(true);
    expect(hubOnly.allowsInbound(inboundMessage("agent.resident.set.request"))).toBe(false);
  });

  test("flushing a Main Control inbox requires workspace write", () => {
    const request = inboundMessage("agent.inbox.flush.request");
    const response = outboundMessage("agent.inbox.flush.response");
    const readOnly = new SessionAuthorization(["workspace.read"]);
    const writer = new SessionAuthorization(["workspace.write"]);
    expect(readOnly.allowsInbound(request)).toBe(false);
    expect(readOnly.allowsOutbound(response)).toBe(false);
    expect(writer.allowsInbound(request)).toBe(true);
    expect(writer.allowsOutbound(response)).toBe(true);
  });

  test("workbench RPCs require the same explicit workspace permission in both directions", () => {
    const operations = {
      "workspace.read": [
        "workspace.durable_item.list",
        "checkout.git.working_tree.get",
        "checkout.git.commit.generate_message",
        "checkout.git.stash.list",
        "checkout.git.stash.show",
        "checkout.git.repos.discover",
        "checkout.git.refs.list",
        "checkout.git.log.query",
        "checkout.git.commit.get_detail",
        "checkout.git.rebase.build_plan",
        "checkout.git.conflict.inspect",
        "checkout.git.blame.get",
        "checkout.git.push.prepare",
      ],
      "workspace.write": [
        "workspace.durable_item.decide",
        "checkout.git.stage.apply",
        "checkout.git.unstage.apply",
        "checkout.git.discard.apply",
        "checkout.git.commit.create",
        "checkout.git.stash.create",
        "checkout.git.stash.apply",
        "checkout.git.stash.drop",
        "checkout.git.branch.mutate",
        "checkout.git.rebase.execute",
        "checkout.git.rebase.act",
        "checkout.git.conflict.resolve",
        "checkout.git.tag.mutate",
        "checkout.git.push.force",
      ],
      "workspace.manage": ["workspace.topic.update"],
    } as const;
    const workspaceGrants = ["workspace.read", "workspace.write", "workspace.manage"] as const;
    for (const required of workspaceGrants) {
      for (const operation of operations[required]) {
        for (const grant of [...workspaceGrants, "hub.execute"] as const) {
          const authorization = new SessionAuthorization([grant]);
          expect(authorization.allowsInbound(inboundMessage(`${operation}.request`))).toBe(
            grant === required,
          );
          expect(authorization.allowsOutbound(outboundMessage(`${operation}.response`))).toBe(
            grant === required,
          );
        }
      }
    }

    const reader = new SessionAuthorization(["workspace.read"]);
    expect(reader.allowsInbound(inboundMessage("checkout_commit_request"))).toBe(false);
    expect(reader.allowsInbound(inboundMessage("checkout.commits.list.request"))).toBe(true);
    expect(reader.allowsInbound(inboundMessage("workspace.create.request"))).toBe(false);
  });

  test("owner authority covers every session operation", () => {
    const authorization = new SessionAuthorization(OWNER_PERMISSIONS);

    expect(
      inboundOperationTypes().every((type) => authorization.allowsInbound(inboundMessage(type))),
    ).toBe(true);
    expect(
      outboundOperationTypes().every((type) => authorization.allowsOutbound(outboundMessage(type))),
    ).toBe(true);
  });

  test("semantic permissions authorize operations instead of RPC namespaces", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);

    expect(authorization.allowsInbound(inboundMessage("hub.execution.agent.create.request"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("hub.execution.agent.update"))).toBe(true);
    expect(authorization.allowsInbound(inboundMessage("get_providers_snapshot_request"))).toBe(
      true,
    );
    expect(authorization.allowsInbound(inboundMessage("refresh_providers_snapshot_request"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("get_providers_snapshot_response"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("providers_snapshot_update"))).toBe(true);
    expect(
      authorization.allowsOutbound(outboundMessage("refresh_providers_snapshot_response")),
    ).toBe(true);
    expect(authorization.allowsInbound(inboundMessage("get_daemon_config_request"))).toBe(false);
    expect(authorization.allowsInbound(inboundMessage("provider_diagnostic_request"))).toBe(false);
    expect(authorization.allowsInbound(inboundMessage("ping"))).toBe(false);
    expect(
      authorization.allowsInbound(inboundMessage("hub.management.daemon.get_status.request")),
    ).toBe(false);
  });

  test("Hub can operate ordinary agents and recover workspaces without daemon administration", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);
    for (const type of [
      "create_agent_request",
      "workspace.title.set.request",
      "fetch_agents_request",
      "fetch_agent_request",
      "agent.timeline.set_subscription.request",
      "send_agent_message_request",
      "workspace.recovery.inspect.request",
      "workspace.recovery.restore.request",
      "archive_workspace_request",
      "cancel_agent_request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(true);
    }
    for (const type of [
      "status",
      "agent_update",
      "agent_stream",
      "workspace_update",
      "rpc_error",
      "workspace.title.set.response",
      "fetch_agents_response",
      "fetch_agent_response",
      "agent.timeline.set_subscription.response",
      "send_agent_message_response",
      "workspace.recovery.inspect.response",
      "workspace.recovery.restore.response",
      "archive_workspace_response",
      "cancel_agent_response",
    ] as const) {
      expect(authorization.allowsOutbound(outboundMessage(type))).toBe(true);
    }
    for (const type of [
      "restart_server_request",
      "terminal_input",
      "hub.management.daemon.permissions.update.request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(false);
    }
    expect(
      authorization.allowsOutbound({
        type: "status",
        payload: { status: "shutdown_requested", clientId: "owner", requestId: "shutdown" },
      }),
    ).toBe(false);
    authorization.replacePermissions([]);
    expect(authorization.allowsInbound(inboundMessage("send_agent_message_request"))).toBe(false);
    expect(authorization.allowsOutbound(outboundMessage("agent_update"))).toBe(false);
  });

  test("correlated authorization errors can always be emitted", () => {
    const authorization = new SessionAuthorization([]);

    expect(authorization.allowsOutbound(outboundMessage("rpc_error"))).toBe(true);
  });

  test("legacy Hub authority is translated at one compatibility boundary", () => {
    expect(permissionsForLegacyHubScopes(["hub.execution.*"])).toEqual(["hub.execute"]);
    expect(permissionsForLegacyHubScopes(["*"])).toEqual([]);
  });

  test("permission names are semantic", () => {
    expect(
      DAEMON_PERMISSIONS.every(
        (permission) => !permission.includes("*") && !permission.includes("request"),
      ),
    ).toBe(true);
  });

  test("permission parsing validates against the shared registry and removes duplicates", () => {
    expect(parseDaemonPermissions(["hub.execute", "hub.execute"])).toEqual(["hub.execute"]);
    expect(() => parseDaemonPermissions(["hub.execution.*"])).toThrow("Invalid daemon permission");
  });
});
