import type { ToolPolicy } from "@getpaseo/protocol/agent-types";
import type { AgentSessionConfig, McpServerConfig } from "./agent-sdk-types.js";

export const PASEO_MCP_SERVER_NAME = "paseo";
const PASEO_MCP_PATHNAME = "/mcp/agents";
const runtimePaseoMcpServers = new WeakMap<McpServerConfig, readonly string[] | undefined>();

export function isRuntimePaseoMcpServer(config: McpServerConfig): boolean {
  return runtimePaseoMcpServers.has(config);
}

export function resolveRuntimeMcpToolPolicy(config: AgentSessionConfig): ToolPolicy | undefined {
  const server = config.mcpServers?.[PASEO_MCP_SERVER_NAME];
  const tools = server && runtimePaseoMcpServers.get(server);
  if (!tools?.length) return config.toolPolicy;
  return {
    preapproved: [
      ...(config.toolPolicy?.preapproved ?? []),
      ...tools.map((tool) => ({ kind: "mcp" as const, server: PASEO_MCP_SERVER_NAME, tool })),
    ],
  };
}

export function hasRuntimePaseoMcpToolApprovalList(config: McpServerConfig): boolean {
  return runtimePaseoMcpServers.get(config) !== undefined;
}

export function stripInternalPaseoMcpServer(config: AgentSessionConfig): AgentSessionConfig {
  const mcpServers = config.mcpServers;
  if (!mcpServers) {
    return config;
  }

  const paseoServer = mcpServers[PASEO_MCP_SERVER_NAME];
  if (
    !paseoServer ||
    (!isRuntimePaseoMcpServer(paseoServer) && !hasLegacyPaseoMcpPath(paseoServer))
  ) {
    return config;
  }

  const nextMcpServers = { ...mcpServers };
  delete nextMcpServers[PASEO_MCP_SERVER_NAME];

  const next = { ...config };
  if (Object.keys(nextMcpServers).length > 0) {
    next.mcpServers = nextMcpServers;
  } else {
    delete next.mcpServers;
  }
  return next;
}

export function withRuntimePaseoMcpServer(params: {
  config: AgentSessionConfig;
  agentId: string;
  mcpBaseUrl: string | null;
  /**
   * Capability token authenticating the injected connection to the daemon's
   * Agent MCP endpoint. The daemon password is gated off this route, so without
   * this header the agent's MCP requests are rejected when a password is set.
   */
  mcpAuthToken: string | null;
  preapprovedTools?: readonly string[];
}): AgentSessionConfig {
  const storedConfig = stripInternalPaseoMcpServer(params.config);
  if (!params.mcpBaseUrl || storedConfig.mcpServers?.[PASEO_MCP_SERVER_NAME]) {
    return storedConfig;
  }

  // Trust only the object produced by this injection. Keep the shared provider
  // config serializable and don't grant approvals based on its name or URL.
  const runtimeServer: McpServerConfig = {
    type: "http",
    url: `${params.mcpBaseUrl}?callerAgentId=${params.agentId}`,
    ...(params.mcpAuthToken ? { headers: { Authorization: `Bearer ${params.mcpAuthToken}` } } : {}),
  };
  runtimePaseoMcpServers.set(runtimeServer, params.preapprovedTools);
  return {
    ...storedConfig,
    mcpServers: {
      [PASEO_MCP_SERVER_NAME]: runtimeServer,
      ...storedConfig.mcpServers,
    },
  };
}

function hasLegacyPaseoMcpPath(config: McpServerConfig): boolean {
  if (config.type !== "http" && config.type !== "sse") {
    return false;
  }

  try {
    return new URL(config.url).pathname === PASEO_MCP_PATHNAME;
  } catch {
    return false;
  }
}
