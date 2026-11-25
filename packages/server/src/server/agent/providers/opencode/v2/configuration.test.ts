import { describe, expect, test } from "vitest";

import type { AgentSessionConfig, McpServerConfig } from "../../../agent-sdk-types.js";
import { HttpMcpFixture } from "../test-utils/mcp-fixtures.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { controls, permissionRules, refreshMcpPermissionRules } from "./configuration.js";
import { SessionMcp } from "./session-mcp.js";

describe("OpenCode v2 permission rules", () => {
  test("keeps authored permissions when a preapproval has no connected MCP binding", () => {
    expect(
      permissionRules({
        provider: "opencode",
        cwd: "/tmp/project",
        providerOptions: { permission: { bash: { pwd: "allow" }, task: "ask" } },
        toolPolicy: { preapproved: [{ server: "paseo.host", tool: "read/info" }] },
      }),
    ).toEqual([
      { action: "shell", resource: "pwd", effect: "allow" },
      { action: "subagent", resource: "*", effect: "ask" },
    ]);
  });

  test("grants only an exact advertised server and tool on the currently connected binding", async () => {
    const fixture = await HttpMcpFixture.start({ token: "fixture", marker: "test result" });
    const server: McpServerConfig = {
      type: "http",
      url: fixture.url,
      headers: { Authorization: "Bearer fixture" },
    };
    const config: AgentSessionConfig = {
      provider: "opencode",
      cwd: "/tmp",
      toolPolicy: {
        preapproved: [{ kind: "mcp", server: "hub.main", tool: "marker" }],
      },
    };
    const connect = (servers: Record<string, McpServerConfig>) =>
      SessionMcp.connect({
        servers,
        cwd: config.cwd,
        env: {},
        preapproved: config.toolPolicy?.preapproved,
      });
    const opened: SessionMcp[] = [];
    const open = async (servers: Record<string, McpServerConfig>) => {
      const binding = await connect(servers);
      opened.push(binding);
      return binding;
    };
    try {
      const verified = await open({ "hub.main": server });
      const [tool] = verified.tools;
      expect(permissionRules(config, verified)).toEqual([
        { action: tool.name, effect: "allow", resource: tool.permissionResource },
      ]);
      expect(tool.permissionResource).toMatch(/^paseo-mcp-binding-/);

      const other = await open({ hub_main: server });
      expect(other.tools[0]?.name).toBe(tool.name);
      expect(permissionRules(config, other)).toEqual([]);

      const ambiguous = await open({ "hub.main": server, hub_main: server });
      expect(new Set(ambiguous.tools.map(({ name }) => name)).size).toBe(2);
      expect(permissionRules(config, ambiguous)).toEqual([]);

      const reconnected = await open({ "hub.main": server });
      expect(reconnected.tools[0]?.permissionResource).not.toBe(tool.permissionResource);
      const harness = new V2Harness();
      const nativeRule = { action: "shell", resource: "pwd", effect: "ask" } as const;
      harness.info.permissions = [
        { action: tool.name, resource: "*", effect: "allow" },
        ...permissionRules(config, verified),
        nativeRule,
      ];
      await refreshMcpPermissionRules(
        harness.api,
        harness.info,
        config,
        reconnected,
        config.toolPolicy,
      );
      expect(harness.info.permissions).toEqual([
        ...permissionRules(config, reconnected),
        nativeRule,
      ]);
      await refreshMcpPermissionRules(
        harness.api,
        harness.info,
        config,
        undefined,
        config.toolPolicy,
      );
      expect(harness.info.permissions).toEqual([nativeRule]);
    } finally {
      await Promise.all(opened.map((binding) => binding.close()));
      await fixture.close();
    }
  });
});

describe("OpenCode v2 controls", () => {
  test("describes the auto-accept toggle over the auto_accept option", () => {
    expect(controls).toEqual([{ type: "toggle", key: "auto_accept", label: "Auto-accept" }]);
  });
});
