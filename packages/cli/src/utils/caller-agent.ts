import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import type { CommandError } from "../output/index.js";

interface CallerLookupClient {
  fetchAgent(options: { agentId: string }): Promise<{
    agent: {
      id: string;
      cwd?: string;
      workspaceId?: string;
      archivedAt?: string | null;
    };
  } | null>;
}

export const AGENT_WORKSPACE_CREATION_ERROR =
  "Agent sessions cannot create a project or workspace. Subagents must reuse the current workspace.";

const INVALID_CALLER_AGENT_ERROR =
  "PASEO_AGENT_ID must identify an active agent with a workspace on the selected daemon.";

export interface CallerAgentContext {
  id: string;
  cwd: string;
  workspaceId: string;
}

export function agentWorkspaceCreationError(): CommandError {
  return {
    code: "AGENT_WORKSPACE_CREATION_FORBIDDEN",
    message: AGENT_WORKSPACE_CREATION_ERROR,
  };
}

function invalidCallerAgentError(details?: unknown): CommandError {
  return {
    code: "INVALID_CALLER_AGENT",
    message: INVALID_CALLER_AGENT_ERROR,
    ...(details ? { details } : {}),
  };
}

// PASEO_AGENT_ID belongs to the daemon that launched this shell. Commands
// targeting another daemon (--host or --home) must not become human calls on
// that daemon when the caller cannot be found there.
export async function resolveCallerAgent(
  client: CallerLookupClient,
  env: { PASEO_AGENT_ID?: string } = process.env,
): Promise<CallerAgentContext | undefined> {
  if (env.PASEO_AGENT_ID === undefined) return undefined;
  const agentId = env.PASEO_AGENT_ID.trim();
  if (!agentId) throw invalidCallerAgentError();

  let caller: Awaited<ReturnType<CallerLookupClient["fetchAgent"]>>;
  try {
    caller = await client.fetchAgent({ agentId });
  } catch (error) {
    // A missing or rejected agent is still a managed caller failure. A lost or
    // timed-out connection remains distinguishable to the command wrapper.
    if (error instanceof DaemonConnectionError) throw error;
    throw invalidCallerAgentError(error instanceof Error ? error.message : String(error));
  }

  const agent = caller?.agent;
  if (
    !agent ||
    agent.id !== agentId ||
    Boolean(agent.archivedAt) ||
    !agent.workspaceId ||
    !agent.cwd
  ) {
    throw invalidCallerAgentError();
  }

  return { id: agent.id, cwd: agent.cwd, workspaceId: agent.workspaceId };
}

export async function resolveCallerAgentId(
  client: CallerLookupClient,
  env: { PASEO_AGENT_ID?: string } = process.env,
): Promise<string | undefined> {
  return (await resolveCallerAgent(client, env))?.id;
}
