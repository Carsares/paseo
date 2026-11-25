import type { SessionInfo, PermissionRuleset } from "@opencode/client";
import type { V2Api } from "./api.js";

import type { AgentOptionControl, AgentSessionConfig } from "../../../agent-sdk-types.js";
import { resolveRuntimeMcpToolPolicy } from "../../../runtime-mcp-config.js";

import { OpenCodeProviderOptionsSchema, buildOpenCodePermissionRules } from "../options.js";

import { modelRef } from "./mapping.js";
import { SessionMcp, openCodeMcpToolName } from "./session-mcp.js";

export const controls: AgentOptionControl[] = [
  { type: "toggle", key: "auto_accept", label: "Auto-accept" },
];
export function permissionRules(config: AgentSessionConfig, mcp?: SessionMcp): PermissionRuleset {
  const rules =
    buildOpenCodePermissionRules(
      OpenCodeProviderOptionsSchema.parse(config.providerOptions ?? {}),
      undefined,
    ) ?? [];
  return [
    ...(mcp?.preapprovalRules() ?? []),
    ...rules.map((rule) => ({
      action: nativePermissionAction(rule.permission),
      resource: rule.pattern,
      effect: rule.action,
    })),
  ];
}
export async function refreshMcpPermissionRules(
  client: V2Api,
  info: SessionInfo,
  config: AgentSessionConfig,
  mcp: SessionMcp | undefined,
  previousPolicy: unknown,
): Promise<void> {
  const legacyActions = new Set(
    [
      ...legacyGrants(previousPolicy),
      ...(resolveRuntimeMcpToolPolicy(config)?.preapproved ?? []),
    ].map(({ server, tool }) => openCodeMcpToolName(server, tool)),
  );
  const authoredAllows = new Set(
    permissionRules(config)
      .filter(({ resource, effect }) => resource === "*" && effect === "allow")
      .map(({ action }) => action),
  );
  const current = info.permissions ?? [];
  const retained = current.filter(
    ({ action, resource, effect }) =>
      !SessionMcp.isPermissionResource(resource) &&
      !(
        legacyActions.has(action) &&
        resource === "*" &&
        effect === "allow" &&
        !authoredAllows.has(action)
      ),
  );
  const next = [...(mcp?.preapprovalRules() ?? []), ...retained];
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  await client.session.update({ sessionID: info.id, permissions: next });
  info.permissions = next;
}

function legacyGrants(policy: unknown): Array<{ server: string; tool: string }> {
  if (typeof policy !== "object" || policy === null) return [];
  const grants: unknown = Reflect.get(policy, "preapproved");
  if (!Array.isArray(grants)) return [];
  return grants.flatMap((grant: unknown) => {
    if (typeof grant !== "object" || grant === null) return [];
    const server: unknown = Reflect.get(grant, "server");
    const tool: unknown = Reflect.get(grant, "tool");
    return typeof server === "string" && typeof tool === "string" ? [{ server, tool }] : [];
  });
}

function nativePermissionAction(action: string): string {
  if (action === "bash") return "shell";
  if (action === "task") return "subagent";
  return action;
}
export async function applyResumeOverrides(
  client: V2Api,
  info: SessionInfo,
  overrides?: Partial<AgentSessionConfig>,
) {
  if (overrides?.modeId) {
    await client.session.switchAgent({
      sessionID: info.id,
      agent: overrides.modeId,
    });
    info.agent = overrides.modeId;
  }
  if (overrides?.model || overrides?.thinkingOptionId !== undefined) {
    const model = overrides.model
      ? modelRef(overrides.model, overrides.thinkingOptionId ?? info.model?.variant)
      : info.model && { ...info.model, variant: overrides.thinkingOptionId };
    if (!model) throw new Error("Select an OpenCode model before changing its variant");
    await client.session.switchModel({ sessionID: info.id, model });
    info.model = model;
  }
}
