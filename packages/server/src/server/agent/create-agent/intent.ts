import { PARENT_AGENT_ID_LABEL, PARENT_SERVER_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  MAX_SUBAGENT_DEPTH,
  REMOTE_HIERARCHY_DEPTH_LABEL,
  RESERVED_HIERARCHY_LABELS,
} from "../hierarchy-policy.js";

export interface CreateAgentCaller {
  id: string;
  cwd: string;
  workspaceId?: string;
}

/** The agent on whose behalf something is created, as far as background inheritance goes. */
export interface BackgroundCaller {
  background?: boolean;
}

/** Omitted, an agent inherits its caller agent's own background; without a caller it is visible. */
export function inheritAgentBackground(
  requested: boolean | undefined,
  caller: BackgroundCaller | null | undefined,
): boolean {
  return requested ?? caller?.background === true;
}

/**
 * Omitted, a new workspace inherits its caller's effective background. A background caller
 * agent decides it here; otherwise `undefined` lets provisioning apply the caller workspace's value.
 */
export function inheritWorkspaceBackground(
  requested: boolean | undefined,
  caller: BackgroundCaller | null | undefined,
): boolean | undefined {
  return requested ?? (caller?.background === true ? true : undefined);
}

export interface CreateAgentPlacement {
  workspaceId: string;
  cwd: string;
}

export interface CreateAgentIntent {
  workspaceId: string;
  cwd: string;
  parentAgentId: string | null;
  labels: Record<string, string>;
}

export async function resolveCreateAgentIntent(input: {
  explicitWorkspaceId?: string;
  caller: CreateAgentCaller | null;
  labels?: Record<string, string>;
  childAgentDefaultLabels?: Record<string, string>;
  serverId?: string;
  resolveWorkspace: (workspaceId: string) => Promise<CreateAgentPlacement>;
  createWorkspace: () => Promise<CreateAgentPlacement>;
  legacyDetached?: boolean;
}): Promise<CreateAgentIntent> {
  const parentAgentId = input.legacyDetached ? null : (input.caller?.id ?? null);
  const labels = {
    ...input.childAgentDefaultLabels,
    ...input.labels,
  };
  for (const key of RESERVED_HIERARCHY_LABELS) delete labels[key];
  // COMPAT(detachedCreate): legacy callers may still request detached creation.
  // Added in v0.2.0; remove after 2027-01-17 once detached creation is outside the floor.
  if (parentAgentId) {
    labels[PARENT_AGENT_ID_LABEL] = parentAgentId;
    if (input.serverId) labels[PARENT_SERVER_ID_LABEL] = input.serverId;
  } else if (!input.caller && !input.legacyDetached && input.serverId) {
    Object.assign(labels, validatedRemoteParentLabels(input.labels, input.serverId));
  }

  const placement = await resolvePlacement(input);
  return { ...placement, parentAgentId, labels };
}

function validatedRemoteParentLabels(
  labels: Record<string, string> | undefined,
  serverId: string,
): Record<string, string> {
  const parentId = labels?.[PARENT_AGENT_ID_LABEL]?.trim();
  const parentServerId = labels?.[PARENT_SERVER_ID_LABEL]?.trim();
  if (!parentId || !parentServerId || parentServerId === serverId) return {};
  const parentLabels = {
    [PARENT_AGENT_ID_LABEL]: parentId,
    [PARENT_SERVER_ID_LABEL]: parentServerId,
  };
  const rawDepth = labels?.[REMOTE_HIERARCHY_DEPTH_LABEL];
  if (rawDepth === undefined) return parentLabels;
  const depth = Number(rawDepth);
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_SUBAGENT_DEPTH) {
    throw new Error(`Invalid remote subagent depth: ${rawDepth}`);
  }
  return { ...parentLabels, [REMOTE_HIERARCHY_DEPTH_LABEL]: String(depth) };
}

async function resolvePlacement(input: {
  explicitWorkspaceId?: string;
  caller: CreateAgentCaller | null;
  resolveWorkspace: (workspaceId: string) => Promise<CreateAgentPlacement>;
  createWorkspace: () => Promise<CreateAgentPlacement>;
}): Promise<CreateAgentPlacement> {
  if (input.explicitWorkspaceId) {
    return input.resolveWorkspace(input.explicitWorkspaceId);
  }
  if (input.caller) {
    if (!input.caller.workspaceId) {
      throw new Error(`Caller agent ${input.caller.id} has no workspace`);
    }
    return { workspaceId: input.caller.workspaceId, cwd: input.caller.cwd };
  }
  return input.createWorkspace();
}
