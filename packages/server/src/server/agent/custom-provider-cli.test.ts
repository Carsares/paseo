import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomProviderCliDraft, MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { findExecutableWithoutProbing } from "../../executable-resolution/executable-resolution.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { loadPersistedConfigAsync } from "../persisted-config.js";
import {
  checkCustomProviderCliLaunch,
  isDynamicProviderLauncher,
  prepareCustomProviderCliDiscovery,
  runCustomProviderCliOperation,
} from "./custom-provider-cli.js";
import { attachMutableProviderConfigOwner } from "./mutable-provider-config-owner.js";
import { installationActivity } from "./provider-installation/installation-activity.js";
import type { ProviderOverride } from "./provider-launch-config.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";
import { CodexAppServerAgentClient } from "./providers/codex-app-server-agent.js";
import { GenericACPAgentClient } from "./providers/generic-acp-agent.js";
import {
  assertScopedLaunch,
  currentCustomProviderLaunch,
  currentOpenCodeDiscovery,
  prepareOwnedOpenCodeLaunch,
} from "./scoped-custom-provider-launch.js";

let root: string;
let marker: string;
let script: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "custom-cli-spec-"));
  marker = path.join(root, "child.json");
  script = path.join(root, "agent.cjs");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function daemonConfig(providers: Record<string, ProviderOverride> = {}) {
  await writeProviderConfig(providers);
  const initial: MutableDaemonConfig = {
    mcp: { injectIntoAgents: false },
    providers,
    browserTools: { enabled: false },
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  };
  return new DaemonConfigStore(root, initial);
}

function cliDependencies(configStore: DaemonConfigStore) {
  return { configStore, isRegisteredProvider: () => false, isPluginProvider: () => false };
}

async function writeProviderConfig(providers: Record<string, ProviderOverride>): Promise<void> {
  await writeFile(
    path.join(root, "config.json"),
    JSON.stringify({ version: 1, agents: { providers } }),
  );
}

async function makeCli(behavior: "ok" | "error" | "hang"): Promise<string[]> {
  await writeFile(
    script,
    [
      'const fs = require("node:fs");',
      'const readline = require("node:readline");',
      "const methods = [];",
      "const trace = {",
      "  pid: process.pid, cwd: process.cwd(), home: process.env.HOME, methods,",
      "  argv: process.argv.slice(3),",
      "  receivedSecret: Boolean(process.env.PASEO_CLI_PRIVATE),",
      "};",
      "const record = () => fs.writeFileSync(process.argv[2], JSON.stringify(trace));",
      "record();",
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 10000);",
      'readline.createInterface({ input: process.stdin }).on("line", (line) => {',
      "  const request = JSON.parse(line);",
      "  methods.push(request.method);",
      "  record();",
      '  process.stderr.write("private-stderr-sentinel\\n");',
      "  const { id, params } = request;",
      '  const jsonrpc = "2.0";',
      "  const result = { protocolVersion: params.protocolVersion };",
      '  const error = { code: -32603, message: "private-stdout-sentinel" };',
      behavior === "ok"
        ? '  process.stdout.write(JSON.stringify({ jsonrpc, id, result }) + "\\n");'
        : "",
      behavior === "error"
        ? '  process.stdout.write(JSON.stringify({ jsonrpc, id, error }) + "\\n");'
        : "",
      "});",
    ].join("\n"),
  );
  return [process.execPath, script, marker, "one argument with spaces", "literal;argument"];
}

function acpDraft(command: string[]): CustomProviderCliDraft {
  return { mode: "create", providerId: "my-acp", extends: "acp", label: "My ACP", command };
}

function expectUnauthorizedLaunch(input: Parameters<typeof assertScopedLaunch>[0]) {
  expect(() => assertScopedLaunch(input)).toThrow("Custom CLI launch did not match");
}

function expectOpenCodeLaunchBinding(command: string[], cwd: string) {
  const scope = currentCustomProviderLaunch()!;
  expect(scope.cwd).toBe(cwd);
  const input = {
    adapter: "opencode",
    operation: "opencode.serve.v1" as const,
    cwd: scope.processCwd,
    env: scope.env,
    file: scope.file,
    argv: [...command, "serve", "--port", "4321"],
  };
  expect(assertScopedLaunch(input)?.entrypoint).toBe(process.execPath);
  for (const differing of [
    { ...input, operation: undefined },
    { ...input, operation: "opencode.version" as const },
    { ...input, cwd: path.dirname(cwd) },
    { ...input, argv: [...input.argv, "--other"] },
    { ...input, argv: [...command, "serve", "--port", "99999"] },
    { ...input, argv: [...command, "serve", "--port", "04321"] },
    { ...input, env: { ...input.env, PATH: cwd }, envOverlays: [{ PATH: cwd }] },
  ]) {
    expectUnauthorizedLaunch(differing);
  }
  expect(
    assertScopedLaunch({
      ...input,
      operation: "opencode.serve.v2",
      argv: [...command, "serve", "--hostname", "127.0.0.1", "--port", "0"],
    })?.entrypoint,
  ).toBe(process.execPath);
}

async function validateOpenCodeBinding(command: string[], cwd: string) {
  expect(currentOpenCodeDiscovery()).toBe(true);
  expect(currentCustomProviderLaunch()).toBeUndefined();
  await expect(access(cwd)).rejects.toMatchObject({ code: "ENOENT" });
  const binding = await prepareOwnedOpenCodeLaunch(cwd);
  await expect(prepareOwnedOpenCodeLaunch(cwd)).rejects.toThrow(
    "OpenCode launch is not authorized",
  );
  await binding.run(async () => expectOpenCodeLaunchBinding(command, cwd));
  return binding;
}

describe("custom provider CLI operations", () => {
  it("publishes the configured Claude catalog without starting its executable", async () => {
    const command = await makeCli("error");
    const configDir = path.join(root, "claude-config");
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const commandSettings = { mode: "replace" as const, argv: command };
    const store = await daemonConfig({ claude: { command, env } });
    const approved = await prepareCustomProviderCliDiscovery(
      { mode: "edit", providerId: "claude" },
      cliDependencies(store),
      root,
    );
    if (approved.status !== "ok") throw new Error(`Authorization failed: ${approved.status}`);
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { command: commandSettings, env },
    });
    await approved.run(async () => {
      expect(await client.isAvailable()).toBe(true);
      expect(
        (await client.fetchCatalog({ scope: "workspace", cwd: root })).models.length,
      ).toBeGreaterThan(0);
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("authorizes only the exact OpenCode discovery operation, working directory and environment", async () => {
    vi.stubEnv("PASEO_HOME", root);
    const command = await makeCli("error");
    const store = await daemonConfig({ opencode: { command } });
    const approved = await prepareCustomProviderCliDiscovery(
      { mode: "edit", providerId: "opencode" },
      cliDependencies(store),
      root,
    );
    if (approved.status !== "ok") throw new Error(`Authorization failed: ${approved.status}`);
    await expect(approved.run(() => prepareOwnedOpenCodeLaunch(root))).rejects.toThrow(
      "OpenCode launch directory did not match discovery authorization",
    );
    const binding = await approved.run(() =>
      validateOpenCodeBinding(command, path.join(root, "opencode-home")),
    );
    await expect(binding.run(async () => undefined)).rejects.toThrow(
      "OpenCode launch is not authorized",
    );
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.skipIf(process.platform === "win32")(
    "locates a shell wrapper but refuses it for either launch path and save",
    async () => {
      const shell = path.join(root, "agent-shim");
      await writeFile(shell, '#!/bin/sh\nprintf started > "$1"\n', { mode: 0o700 });
      const configStore = await daemonConfig();
      const deps = cliDependencies(configStore);
      const draft = acpDraft([shell, marker]);
      expect(await isDynamicProviderLauncher([shell, marker], { PATH: root })).toBe(false);
      expect(await runCustomProviderCliOperation("locate", draft, deps)).toEqual({
        status: "ok",
        path: shell,
      });
      expect(await runCustomProviderCliOperation("save", draft, deps)).toEqual({
        status: "blocked",
      });
      expect(await runCustomProviderCliOperation("test", draft, deps)).toEqual({
        status: "blocked",
      });
      expect(await checkCustomProviderCliLaunch(draft, deps)).toEqual({ status: "blocked" });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("blocks ACP spawning when the platform cannot contain the process tree", async () => {
    const deps = cliDependencies(await daemonConfig());
    const command = await makeCli("ok");
    const platform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(await runCustomProviderCliOperation("test", acpDraft(command), deps)).toEqual({
        status: "unsupported",
      });
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "uses the form PATH for Codex lookup, availability and app-server spawn",
    async () => {
      const ambient = path.join(root, "ambient");
      const configured = path.join(root, "configured");
      const ambientMarker = path.join(root, "wrong-launch");
      const daemonHome = path.join(root, "codex-test");
      await Promise.all([mkdir(ambient), mkdir(configured)]);
      const executable = path.join(configured, "codex");
      await writeFile(
        path.join(ambient, "codex"),
        [
          "#!" + process.execPath,
          'require("node:fs").writeFileSync(' + JSON.stringify(ambientMarker) + ', "wrong");',
        ].join("\n") + "\n",
        { mode: 0o700 },
      );
      await writeFile(
        executable,
        [
          "#!" + process.execPath,
          'require("node:fs").writeFileSync(' +
            JSON.stringify(marker) +
            ", JSON.stringify(process.argv.slice(2)));",
          'require("node:readline").createInterface({input: process.stdin}).on("line", (line) => {',
          "  const msg = JSON.parse(line);",
          '  if (msg.id !== undefined) process.stdout.write(JSON.stringify({id: msg.id, result: {data: []}}) + "\\n");',
          "});",
        ].join("\n") + "\n",
        { mode: 0o700 },
      );
      const configStore = await daemonConfig();
      const env = { PATH: configured, CODEX_HOME: daemonHome };
      const draft = { mode: "edit", providerId: "codex", env } as const;
      vi.stubEnv("PATH", [ambient, "/usr/bin", "/bin"].join(path.delimiter));
      const deps = cliDependencies(configStore);
      expect(await runCustomProviderCliOperation("locate", draft, deps)).toEqual({
        status: "ok",
        path: executable,
      });
      expect(await checkCustomProviderCliLaunch(draft, deps)).toEqual({
        status: "ok",
        path: executable,
      });
      const client = new CodexAppServerAgentClient(createTestLogger(), { env });
      await expect(client.isAvailable()).resolves.toBe(true);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(client.listImportableSessions()).resolves.toEqual([]);
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual(["app-server"]);
      await expect(access(ambientMarker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects inherited command and environment changes made on disk and clears description explicitly", async () => {
    const original = { command: [process.execPath], env: { CODEX_ENDPOINT: "old" } };
    const entry = { extends: "codex", label: "Derived", description: "Old description" };
    const configStore = await daemonConfig({ codex: original, derived: entry });
    const deps = cliDependencies(configStore);
    const inherited = {
      mode: "create",
      providerId: "second",
      extends: "codex",
      label: "Second",
    } as const;
    for (const changed of [
      { ...original, command: [process.execPath, "different"] },
      { ...original, env: { CODEX_ENDPOINT: "new" } },
    ]) {
      await writeProviderConfig({ codex: changed, derived: entry });
      expect(await runCustomProviderCliOperation("save", inherited, deps)).toEqual({
        status: "blocked",
        reason: "reload_required",
      });
      expect(configStore.get().providers["second"]).toBeUndefined();
    }
    await writeProviderConfig({ codex: original, derived: entry });
    expect(
      await runCustomProviderCliOperation(
        "save",
        {
          mode: "edit",
          providerId: "derived",
          description: "",
        },
        deps,
      ),
    ).toEqual({ status: "ok" });
    expect((await loadPersistedConfigAsync(root)).agents?.providers?.["derived"]).toEqual({
      ...entry,
      description: "",
    });
  });

  it.skipIf(process.platform === "win32")(
    "binds ACP catalog startup to the approved file and workspace directory",
    async () => {
      const workspace = path.join(root, "workspace");
      const cwd = path.join(root, "workspace-link");
      await mkdir(workspace);
      await symlink(workspace, cwd);
      await writeFile(
        script,
        [
          'const fs = require("node:fs");',
          'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
          "  const req = JSON.parse(line);",
          '  if (req.method === "session/new") fs.writeFileSync(process.argv[2], JSON.stringify({ processCwd: process.cwd(), sessionCwd: req.params.cwd }));',
          '  const result = req.method === "initialize" ? { protocolVersion: req.params.protocolVersion } : { sessionId: "probe" };',
          '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");',
          "});",
        ].join("\n"),
      );
      const command: [string, ...string[]] = [process.execPath, script, marker];
      const configStore = await daemonConfig({
        "my-acp": { extends: "acp", label: "ACP", command },
      });
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command,
        providerId: "my-acp",
      });
      const approve = () =>
        prepareCustomProviderCliDiscovery(
          { mode: "edit", providerId: "my-acp" },
          cliDependencies(configStore),
          cwd + "/.",
        );
      const approved = await approve();
      if (approved.status !== "ok") throw new Error(`Authorization failed: ${approved.status}`);
      const options = { scope: "workspace", cwd } as const;
      await approved.run(() => client.fetchCatalog(options));
      const resolved = await realpath(workspace);
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
        processCwd: resolved,
        sessionCwd: resolved,
      });
      await client.fetchCatalog(options);
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
        processCwd: await realpath(process.cwd()),
        sessionCwd: cwd,
      });
      await rm(marker);

      const stale = await approve();
      if (stale.status !== "ok") throw new Error(`Authorization failed: ${stale.status}`);
      await expect(
        stale.run(async () => {
          await rename(script, `${script}.old`);
          await writeFile(script, 'require("node:fs").writeFileSync(process.argv[2], "wrong");');
          return client.fetchCatalog(options);
        }),
      ).rejects.toThrow("Custom CLI launch file changed");
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "stops ACP discovery when its approved directory link is redirected before session/new",
    async () => {
      const workspace = path.join(root, "workspace");
      const other = path.join(root, "other");
      const cwd = path.join(root, "workspace-link");
      const started = path.join(root, "started");
      await Promise.all([mkdir(workspace), mkdir(other)]);
      await symlink(workspace, cwd);
      await writeFile(
        script,
        [
          'const fs = require("node:fs");',
          "const [marker, started, cwd, other] = process.argv.slice(2);",
          "fs.writeFileSync(started, process.cwd());",
          'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
          "  const req = JSON.parse(line);",
          '  if (req.method === "initialize") {',
          "    fs.unlinkSync(cwd);",
          "    fs.symlinkSync(other, cwd);",
          "  }",
          '  if (req.method === "session/new") fs.writeFileSync(marker, req.params.cwd);',
          '  if (req.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: req.params.protocolVersion } }) + "\\n");',
          "});",
        ].join("\n"),
      );
      const command: [string, ...string[]] = [
        process.execPath,
        script,
        marker,
        started,
        cwd,
        other,
      ];
      const deps = cliDependencies(
        await daemonConfig({ "my-acp": { extends: "acp", label: "ACP", command } }),
      );
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command,
        providerId: "my-acp",
      });
      const options = { scope: "workspace", cwd } as const;
      const draft = { mode: "edit", providerId: "my-acp" } as const;
      const approved = await prepareCustomProviderCliDiscovery(draft, deps, cwd);
      if (approved.status !== "ok") throw new Error(`Authorization failed: ${approved.status}`);
      await expect(
        approved.run(async () => {
          await rm(cwd);
          await symlink(other, cwd);
          return client.fetchCatalog(options);
        }),
      ).rejects.toThrow("Custom CLI launch directory changed");
      await expect(access(started)).rejects.toMatchObject({ code: "ENOENT" });

      await rm(cwd);
      await symlink(workspace, cwd);
      const beforeInitialize = await prepareCustomProviderCliDiscovery(draft, deps, cwd);
      if (beforeInitialize.status !== "ok") {
        throw new Error(`Authorization failed: ${beforeInitialize.status}`);
      }
      await expect(beforeInitialize.run(() => client.fetchCatalog(options))).rejects.toThrow(
        "Custom CLI launch directory changed",
      );
      expect(await readFile(started, "utf8")).toBe(await realpath(workspace));
      expect(await realpath(cwd)).toBe(await realpath(other));
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["acp", "rpc-error"],
    ["codex", "rpc-error"],
    ["acp", "early-exit"],
    ["codex", "early-exit"],
  ] as const)(
    "sanitizes %s discovery on %s and reaps the descendant holding its pipes",
    async (adapter, mode) => {
      const sentinel = "private-provider-output";
      await writeFile(
        script,
        [
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          'require("node:readline").createInterface({ input: process.stdin }).once("line", (line) => {',
          '  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", 1, 2] });',
          "  child.unref();",
          '  child.once("spawn", () => {',
          "    fs.writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));",
          "    const { id } = JSON.parse(line);",
          "    const secret = process.argv[3];",
          "    console.error(secret);",
          "    console.log(secret);",
          '    console.log(JSON.stringify({ jsonrpc: "2.0", method: "unregistered", params: { secret } }));',
          '    if (process.argv[4] === "early-exit") process.exit(1);',
          '    console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: secret, data: secret } }));',
          "    setInterval(() => {}, 1000);",
          "  });",
          "});",
        ].join("\n"),
      );
      const command: [string, ...string[]] = [process.execPath, script, marker, sentinel, mode];
      const providerId = adapter === "acp" ? "my-acp" : "codex";
      const env = adapter === "codex" ? { CODEX_HOME: root } : {};
      const store = await daemonConfig({
        [providerId]: {
          ...(adapter === "acp" ? { extends: "acp", label: "ACP" } : {}),
          command,
          env,
        },
      });
      const logs: string[] = [];
      const logger = pino({ level: "trace" }, { write: (line) => logs.push(line) });
      const client =
        adapter === "acp"
          ? new GenericACPAgentClient({ logger, command, providerId })
          : new CodexAppServerAgentClient(logger, {
              command: { mode: "replace", argv: command },
              env,
            });
      const approved = await prepareCustomProviderCliDiscovery(
        { mode: "edit", providerId },
        cliDependencies(store),
        root,
      );
      if (approved.status !== "ok") throw new Error(`Authorization failed: ${approved.status}`);
      const failure = await approved
        .run(() => client.fetchCatalog({ scope: "workspace", cwd: root }))
        .catch((error: unknown) => error);
      const ids = JSON.parse(await readFile(marker, "utf8"));
      expect(failure).toBeInstanceOf(Error);
      if (mode === "rpc-error") expect(String(failure)).toContain("discovery request failed");
      expect(String(failure)).not.toContain(sentinel);
      expect(logs.join("")).not.toContain(sentinel);
      expect(() => process.kill(ids.parent, 0)).toThrow(/ESRCH/u);
      expect(() => process.kill(ids.child, 0)).toThrow(/ESRCH/u);
      installationActivity.acquireUpdate({ family: providerId, keys: [], opaque: true }).release();
    },
  );

  it.skipIf(process.platform === "win32")(
    "bounds ACP discovery stdout and scrubs errors during session close",
    async () => {
      const sentinel = "private-acp-close-output";
      const logs: string[] = [];
      const logger = pino({ level: "trace" }, { write: (line) => logs.push(line) });
      for (const mode of ["oversize", "close"] as const) {
        await writeFile(
          script,
          [
            'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
            "  const { id, method } = JSON.parse(line);",
            "  if (id === undefined) return;",
            '  const output = (value) => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...value }));',
            '  if (method === "initialize") {',
            '    if (process.argv[2] === "oversize") {',
            '      process.stdout.write(Buffer.alloc(9 * 1024 * 1024, "x"));',
            "      return;",
            "    }",
            "    output({ result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } } });",
            '  } else if (method === "session/new") {',
            "    output({ result: { sessionId: process.argv[3] } });",
            '  } else if (method === "session/close") {',
            '    require("node:fs").writeFileSync(process.argv[4], "closed");',
            "    console.error(process.argv[3]);",
            "    output({ error: { code: -32603, message: process.argv[3] } });",
            "  }",
            "});",
          ].join("\n"),
        );
        const command: [string, ...string[]] = [process.execPath, script, mode, sentinel, marker];
        const providerId = "my-acp";
        const store = await daemonConfig({
          [providerId]: { extends: "acp", command, label: "ACP" },
        });
        const client = new GenericACPAgentClient({ logger, command, providerId });
        const approved = await prepareCustomProviderCliDiscovery(
          { mode: "edit", providerId },
          cliDependencies(store),
          root,
        );
        if (approved.status !== "ok") throw new Error(`Authorization failed: ${approved.status}`);
        const result = approved.run(() => client.fetchCatalog({ scope: "workspace", cwd: root }));
        if (mode === "oversize") {
          await expect(result).rejects.toThrow("ACP discovery stdout exceeded the output limit");
        } else {
          await expect(result).resolves.toMatchObject({ models: [] });
          expect(await readFile(marker, "utf8")).toBe("closed");
        }
      }
      expect(logs.join("")).not.toContain(sentinel);
    },
  );

  it.skipIf(process.platform === "win32")(
    "skips a default Codex candidate with a missing interpreter and honors a later candidate",
    async () => {
      const stale = path.join(root, "stale");
      const installed = path.join(root, "installed");
      await Promise.all([mkdir(stale), mkdir(installed)]);
      const bad = path.join(stale, "codex");
      await writeFile(bad, "#!/missing/paseo-test-interpreter\n", { mode: 0o700 });
      await writeFile(
        path.join(installed, "codex"),
        [
          "#!" + process.execPath,
          'if (process.argv.includes("--version")) { console.log("codex 1.0.0"); process.exit(0); }',
          'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "app-server");',
          'require("node:readline").createInterface({input: process.stdin}).on("line", (line) => {',
          "  const msg = JSON.parse(line);",
          '  if (msg.id !== undefined) process.stdout.write(JSON.stringify({id: msg.id, result: {data: []}}) + "\\n");',
          "});",
        ].join("\n") + "\n",
        { mode: 0o700 },
      );
      const env = { PATH: [stale, installed].join(path.delimiter), CODEX_HOME: root };
      const store = await daemonConfig({ codex: { env } });
      expect(
        await runCustomProviderCliOperation(
          "locate",
          { mode: "edit", providerId: "codex" },
          cliDependencies(store),
        ),
      ).toEqual({ status: "ok", path: bad });
      const client = new CodexAppServerAgentClient(createTestLogger(), { env });
      await expect(client.listImportableSessions()).resolves.toEqual([]);
      expect(await readFile(marker, "utf8")).toBe("app-server");

      await rm(marker);
      const override = new CodexAppServerAgentClient(createTestLogger(), {
        env,
        command: { mode: "replace", argv: [bad] },
      });
      await expect(override.listImportableSessions()).rejects.toThrow();
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects the workspace command shim even when PATH contains an acceptable executable",
    async () => {
      const cwd = path.join(root, "workspace");
      const bin = path.join(root, "bin");
      await Promise.all([mkdir(cwd), mkdir(bin)]);
      await copyFile(process.execPath, path.join(bin, "my-agent.EXE"));
      await writeFile(
        path.join(cwd, "my-agent.CMD"),
        `@echo off\r\necho started > "${marker}"\r\n`,
      );
      vi.stubEnv("NoDefaultCurrentDirectoryInExePath", undefined);
      const draft = {
        ...acpDraft(["my-agent", script, marker]),
        env: { PATH: bin, PATHEXT: ".EXE;.CMD" },
      };
      await writeFile(script, "");
      const deps = cliDependencies(await daemonConfig());
      expect((await prepareCustomProviderCliDiscovery(draft, deps, bin)).status).toBe("ok");
      expect(await prepareCustomProviderCliDiscovery(draft, deps, cwd)).toEqual({
        status: "blocked",
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("locates and saves an installed executable without executing it", async () => {
    const configStore = await daemonConfig();
    const command = await makeCli("ok");
    const draft = acpDraft(command);
    expect(
      await runCustomProviderCliOperation("locate", draft, cliDependencies(configStore)),
    ).toEqual({
      status: "ok",
      path: process.execPath,
    });
    expect(
      await runCustomProviderCliOperation("save", draft, cliDependencies(configStore)),
    ).toEqual({
      status: "ok",
    });
    await expect(access(marker, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
    const persisted = await loadPersistedConfigAsync(root);
    expect(persisted.agents?.providers?.["my-acp"]).toEqual({
      extends: "acp",
      label: "My ACP",
      command,
      deferDiscovery: true,
    });
  });

  it("publishes a saved provider without starting it during background discovery", async () => {
    await writeFile(script, 'require("node:fs").writeFileSync(process.argv[2], "started");');
    const providerOverrides = Object.fromEntries(
      BUILTIN_PROVIDER_IDS.map((id) => [id, { enabled: false }]),
    );
    const configStore = await daemonConfig(providerOverrides);
    const manager = new ProviderSnapshotManager({ logger: createTestLogger(), providerOverrides });
    const detach = attachMutableProviderConfigOwner({
      store: configStore,
      providerSnapshotManager: manager,
      updateProviderRegistry: () => undefined,
    });
    try {
      manager.getSnapshot();
      const draft = acpDraft([process.execPath, script, marker]);
      expect(
        await runCustomProviderCliOperation("save", draft, cliDependencies(configStore)),
      ).toEqual({
        status: "ok",
      });
      expect(manager.getProviderLabel(draft.providerId)).toEqual(draft.label);
      manager.getSnapshot();
      await manager.warmUpSnapshotForCwd({ providers: [draft.providerId] });
      await expect(access(marker, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      detach();
      manager.destroy();
    }
  });

  it("does not start a freshly saved native CLI when settings read its installation", async () => {
    await writeFile(
      script,
      [
        'require("node:fs").writeFileSync(process.argv[2], "started");',
        'process.stdout.write("codex-cli 1.2.3\\n");',
      ].join("\n"),
    );
    const configStore = await daemonConfig();
    const manager = new ProviderSnapshotManager({ logger: createTestLogger() });
    const detach = attachMutableProviderConfigOwner({
      store: configStore,
      providerSnapshotManager: manager,
      updateProviderRegistry: () => undefined,
    });
    try {
      const draft = { ...acpDraft([process.execPath, script, marker]), extends: "codex" };
      expect(
        await runCustomProviderCliOperation("save", draft, cliDependencies(configStore)),
      ).toEqual({
        status: "ok",
      });
      expect(manager.isProviderDiscoveryDeferred(draft.providerId)).toBe(true);
      await Promise.allSettled([manager.installations.inspect(draft.providerId)]);
      await expect(access(marker, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      detach();
      manager.destroy();
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects indirect dynamic launchers without executing them and preserves existing hand edits",
    async () => {
      const command = await makeCli("ok");
      const npx = path.join(root, "npx-cli.js");
      await symlink(process.execPath, npx, "file");
      const alias = path.join(root, "my-cli");
      await symlink(npx, alias, "file");
      const configured = ["npm", "exec", "--", "manually-configured-agent"];
      const configStore = await daemonConfig({
        "my-acp": { extends: "acp", label: "Manual", command: configured, env: { KEEP: "on" } },
      });
      const baseDraft = { mode: "edit", providerId: "my-acp" } as const;
      for (const operation of ["locate", "test", "save"] as const) {
        const aliasedCommand = [alias, ...command.slice(1)];
        expect(
          await runCustomProviderCliOperation(
            operation,
            {
              ...baseDraft,
              command: aliasedCommand,
            },
            cliDependencies(configStore),
          ),
        ).toEqual({ status: "blocked" });
      }
      for (const runner of ["npm.EXE", "PNPM.cmd", "bunx", "uvx", "uv", "yarnpkg"]) {
        expect(
          await runCustomProviderCliOperation(
            "save",
            {
              ...baseDraft,
              command: [runner, "exec", "example"],
            },
            cliDependencies(configStore),
          ),
        ).toEqual({ status: "blocked" });
      }
      expect(
        await runCustomProviderCliOperation("test", baseDraft, cliDependencies(configStore)),
      ).toEqual({
        status: "blocked",
      });
      expect(
        await runCustomProviderCliOperation(
          "save",
          {
            ...baseDraft,
            description: "Edited",
            command: configured,
          },
          cliDependencies(configStore),
        ),
      ).toEqual({ status: "ok" });
      await expect(access(marker, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await loadPersistedConfigAsync(root)).agents?.providers?.["my-acp"]).toEqual({
        extends: "acp",
        label: "Manual",
        description: "Edited",
        command: configured,
        env: { KEEP: "on" },
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects recognizable download wrappers without starting their scripts",
    async () => {
      const configStore = await daemonConfig();
      const deps = cliDependencies(configStore);
      const runner = path.join(root, "npx-cli.js");
      await writeFile(runner, 'require("node:fs").writeFileSync(process.argv[2], "started");');
      const alias = path.join(root, "agent-launcher.cjs");
      await symlink(runner, alias, "file");
      const shim = path.join(root, "provider-cli");
      await writeFile(shim, "#!/usr/bin/env -S npx agent-package\n", { mode: 0o700 });

      expect(
        await isDynamicProviderLauncher([process.execPath, alias, marker], { PATH: root }),
      ).toBe(true);
      for (const command of [[process.execPath, alias, marker], [shim]]) {
        for (const operation of ["locate", "test", "save"] as const) {
          expect(await runCustomProviderCliOperation(operation, acpDraft(command), deps)).toEqual({
            status: "blocked",
          });
        }
      }
      await expect(access(marker, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
      expect(configStore.get().providers["my-acp"]).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "classifies legacy paths without launching a script and blocks unresolved aliases",
    async () => {
      const command = await makeCli("ok");
      const runner = path.join(root, "uvx");
      await symlink(command[0], runner);
      const alias = path.join(root, "custom-cli");
      await symlink(runner, alias);
      const missing = path.join(root, "missing-cli");
      await symlink(path.join(root, "unknown-target"), missing);
      const shebang = path.join(root, "legacy-wrapper");
      await writeFile(shebang, "#!/usr/bin/env -S custom-cli package\n", { mode: 0o700 });
      const env = { PATH: root };
      expect(await isDynamicProviderLauncher([command[0], ...command.slice(1)], env)).toBe(false);
      expect(await isDynamicProviderLauncher(["custom-cli"], env)).toBe(true);
      expect(await isDynamicProviderLauncher([missing], env)).toBe(true);
      expect(await isDynamicProviderLauncher([shebang], env)).toBe(true);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "requires a single absolute interpreter in legacy shebangs",
    async () => {
      const launcher = path.join(root, "agent-shim");
      const envAlias = path.join(root, "env-alias");
      const interpreterAlias = path.join(root, "node-alias");
      const nested = path.join(root, "nested-interpreter");
      const runner = path.join(root, "npx");
      const shellAlias = path.join(root, "sh");
      const busyBox = path.join(root, "busybox");
      const busyBoxAlias = path.join(root, "bash");
      const env = { PATH: [root, path.dirname(process.execPath)].join(path.delimiter) };
      const node = path.basename(process.execPath);
      await Promise.all([
        symlink("/usr/bin/env", envAlias),
        symlink(process.execPath, interpreterAlias),
        writeFile(nested, "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
        symlink(process.execPath, runner),
        symlink(runner, shellAlias),
        symlink(process.execPath, busyBox),
        symlink(busyBox, busyBoxAlias),
      ]);

      for (const interpreter of [
        interpreterAlias,
        "/bin/sh",
        "/usr/bin/env " + interpreterAlias,
        "/usr/bin/env -S " + interpreterAlias,
      ]) {
        await writeFile(launcher, "#!" + interpreter + "\n", { mode: 0o700 });
        expect(await isDynamicProviderLauncher([launcher, marker], env), interpreter).toBe(false);
      }
      await writeFile(launcher, "#!" + envAlias + " -S " + interpreterAlias + "\n");
      const envUsesBusyBox = path.basename(await realpath("/usr/bin/env")) === "busybox";
      expect(await isDynamicProviderLauncher([launcher, marker], env)).toBe(envUsesBusyBox);

      for (const interpreter of [
        interpreterAlias + " --no-warnings",
        "/usr/bin/env " + node,
        "/usr/bin/env -S " + node,
        envAlias + " -S " + node,
        "/usr/bin/env -S " + interpreterAlias + " --no-warnings",
        envAlias + " -S " + interpreterAlias + " --no-warnings",
        "/usr/bin/env -S '" + interpreterAlias + "'",
        nested,
        shellAlias,
        busyBoxAlias,
      ]) {
        await writeFile(launcher, "#!" + interpreter + "\n", { mode: 0o700 });
        expect(await isDynamicProviderLauncher([launcher, marker], env), interpreter).toBe(true);
      }
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps a bare Windows legacy command static when the launch directory can shadow PATH", async () => {
    const cwd = path.join(root, "launch");
    const bin = path.join(root, "bin");
    const pathExecutable = path.join(bin, "legacy-cli.EXE");
    const cwdExecutable = path.join(cwd, "legacy-cli.CMD");
    await Promise.all([mkdir(cwd), mkdir(bin)]);
    await Promise.all([
      writeFile(pathExecutable, "ordinary executable"),
      writeFile(cwdExecutable, "@npx fake-package\r\n"),
    ]);
    const env = { PATH: bin, PATHEXT: ".EXE;.CMD" };
    const options = { platform: "win32", cwd, env } as const;
    await expect(findExecutableWithoutProbing("legacy-cli", options)).resolves.toBe(pathExecutable);
    await expect(
      findExecutableWithoutProbing("legacy-cli", {
        ...options,
        searchWindowsLaunchDirectory: true,
      }),
    ).resolves.toBe(cwdExecutable);

    const platform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(await isDynamicProviderLauncher(["legacy-cli"], env)).toBe(true);
      expect(await isDynamicProviderLauncher([pathExecutable], env)).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });

  it.skipIf(process.platform === "win32")(
    "requires a direct absolute script file for legacy interpreter reads",
    async () => {
      const [interpreter, ...args] = await makeCli("ok");
      const relative = [interpreter, "./agent.cjs", ...args.slice(1)];
      const absolute = [interpreter, ...args];
      const env = { PATH: root };
      expect(await isDynamicProviderLauncher([interpreter], env)).toBe(true);
      expect(await isDynamicProviderLauncher([interpreter, root], env)).toBe(true);
      expect(
        await isDynamicProviderLauncher([interpreter, path.join(root, "missing.cjs")], env),
      ).toBe(true);
      expect(await isDynamicProviderLauncher(relative, env)).toBe(true);
      expect(
        await isDynamicProviderLauncher(
          [interpreter, "--require", args[0], ...relative.slice(1)],
          env,
        ),
      ).toBe(true);
      expect(await isDynamicProviderLauncher(absolute, env)).toBe(false);

      const deps = cliDependencies(await daemonConfig());
      const draft = acpDraft(relative);
      expect(await runCustomProviderCliOperation("save", draft, deps)).toEqual({
        status: "blocked",
      });
      expect(await runCustomProviderCliOperation("test", draft, deps)).toEqual({
        status: "blocked",
      });
      expect(await prepareCustomProviderCliDiscovery(draft, deps, root)).toEqual({
        status: "blocked",
      });
      expect(await prepareCustomProviderCliDiscovery(acpDraft(absolute), deps, root)).toMatchObject(
        { status: "ok" },
      );
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "sends only initialize with literal arguments in a temporary directory and reaps the child",
    async () => {
      const command = await makeCli("ok");
      const configStore = await daemonConfig();
      vi.stubEnv("PASEO_CLI_PRIVATE", "ambient-private-sentinel");
      const result = await runCustomProviderCliOperation(
        "test",
        acpDraft(command),
        cliDependencies(configStore),
      );
      expect(result).toEqual({ status: "ok", path: process.execPath });
      const trace = JSON.parse(await readFile(marker, "utf8"));
      expect(trace).toEqual({
        pid: expect.any(Number),
        cwd: expect.stringContaining("paseo-cli-test-"),
        home: expect.stringContaining("paseo-cli-test-"),
        methods: ["initialize"],
        argv: ["one argument with spaces", "literal;argument"],
        receivedSecret: false,
      });
      expect(() => process.kill(trace.pid, 0)).toThrow(/ESRCH/u);
      await expect(access(trace.cwd, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32").each(["error", "hang"] as const)(
    "returns a safe status and reaps a child that reports %s",
    async (behavior) => {
      const configStore = await daemonConfig();
      const command = await makeCli(behavior);
      const result = await runCustomProviderCliOperation(
        "test",
        acpDraft(command),
        cliDependencies(configStore),
      );
      expect(result).toEqual({ status: "failed" });
      const trace = JSON.parse(await readFile(marker, "utf8"));
      expect(trace.methods).toEqual(["initialize"]);
      expect(() => process.kill(trace.pid, 0)).toThrow(/ESRCH/u);
      const update = installationActivity.acquireUpdate({
        family: "my-acp",
        keys: [],
        opaque: true,
      });
      update.release();
    },
  );

  it.skipIf(process.platform === "win32")(
    "terminates an in-progress handshake when its request is aborted",
    async () => {
      const configStore = await daemonConfig();
      const command = await makeCli("hang");
      const controller = new AbortController();
      const result = runCustomProviderCliOperation("test", acpDraft(command), {
        ...cliDependencies(configStore),
        signal: controller.signal,
      });
      const trace = await vi.waitFor(async () => {
        const captured = JSON.parse(await readFile(marker, "utf8"));
        expect(captured.methods).toEqual(["initialize"]);
        return captured;
      });
      controller.abort();
      expect(await result).toEqual({ status: "failed" });
      expect(() => process.kill(trace.pid, 0)).toThrow(/ESRCH/u);
    },
  );

  it.skipIf(process.platform === "win32")(
    "holds installation activity after the direct child exits until the group is gone",
    async () => {
      const deps = cliDependencies(await daemonConfig());
      const descendantScript = path.join(root, "descendant.cjs");
      await writeFile(descendantScript, "setInterval(() => {}, 1000);");
      await writeFile(
        script,
        [
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          'require("node:readline").createInterface({ input: process.stdin }).once("line", () => {',
          '  const child = spawn(process.execPath, [process.argv[3]], { stdio: "ignore" });',
          '  child.once("spawn", () => {',
          "    fs.writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, descendant: child.pid }));",
          "    process.exit(0);",
          "  });",
          "});",
        ].join("\n"),
      );

      const check = { family: "my-acp", keys: [], opaque: true };
      const kill = process.kill.bind(process);
      const admittedWhileChecking: boolean[] = [];
      const signal = vi.spyOn(process, "kill").mockImplementation((pid, name) => {
        if (pid < 0 && name === 0) {
          try {
            installationActivity.acquireUpdate(check).release();
            admittedWhileChecking.push(true);
          } catch {
            admittedWhileChecking.push(false);
          }
        }
        return kill(pid, name);
      });
      try {
        const draft = acpDraft([process.execPath, script, marker, descendantScript]);
        expect(await runCustomProviderCliOperation("test", draft, deps)).toEqual({
          status: "failed",
        });
        const ids = JSON.parse(await readFile(marker, "utf8"));
        expect(() => kill(ids.parent, 0)).toThrow(/ESRCH/u);
        expect(() => kill(ids.descendant, 0)).toThrow(/ESRCH/u);
        expect(admittedWhileChecking).toContain(false);
        expect(admittedWhileChecking).not.toContain(true);
        installationActivity.acquireUpdate(check).release();
      } finally {
        signal.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans up an observed descendant in its own process group before reporting success",
    async () => {
      const descendant = path.join(root, "independent.cjs");
      await writeFile(descendant, "setInterval(() => {}, 1000);");
      await writeFile(
        script,
        [
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          'require("node:readline").createInterface({ input: process.stdin }).once("line", (line) => {',
          '  const child = spawn(process.execPath, [process.argv[3]], { detached: true, stdio: "ignore" });',
          '  child.once("spawn", () => {',
          "    fs.writeFileSync(process.argv[2], String(child.pid));",
          "    const { id, params: { protocolVersion } } = JSON.parse(line);",
          '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion } }) + "\\n");',
          "  });",
          "});",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const draft = acpDraft([process.execPath, script, marker, descendant]);
      const result = await runCustomProviderCliOperation(
        "test",
        draft,
        cliDependencies(await daemonConfig()),
      );
      const pid = Number(await readFile(marker, "utf8"));
      try {
        expect(result).toEqual({ status: "ok", path: process.execPath });
        expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
        installationActivity.acquireUpdate({ family: "my-acp", keys: [], opaque: true }).release();
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          expect(error).toMatchObject({ code: "ESRCH" });
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "releases installation activity when delayed group cleanup is finally confirmed",
    async () => {
      const deps = cliDependencies(await daemonConfig());
      const command = await makeCli("ok");
      const activity = { family: "my-acp", keys: [], opaque: true };
      const realKill = process.kill.bind(process);
      let reportGroupGone = false;
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (!reportGroupGone && pid < 0 && signal === 0) return true;
        return realKill(pid, signal);
      });
      try {
        expect(await runCustomProviderCliOperation("test", acpDraft(command), deps)).toEqual({
          status: "failed",
        });
        expect(() => installationActivity.acquireUpdate(activity)).toThrow();
        reportGroupGone = true;
        await vi.waitFor(() => installationActivity.acquireUpdate(activity).release());
      } finally {
        kill.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to test during an installation update and never opens a native provider runtime",
    async () => {
      const configStore = await daemonConfig();
      const command = await makeCli("ok");
      const draft = { ...acpDraft(command), extends: "codex" };
      expect(
        await runCustomProviderCliOperation("test", draft, cliDependencies(configStore)),
      ).toEqual({
        status: "unsupported",
      });
      const update = installationActivity.acquireUpdate({
        family: "other",
        keys: [],
        opaque: true,
      });
      try {
        expect(
          await runCustomProviderCliOperation(
            "test",
            acpDraft(command),
            cliDependencies(configStore),
          ),
        ).toEqual({ status: "blocked" });
        await expect(access(marker, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        update.release();
      }
    },
  );

  it("serializes duplicate creation and concurrent environment writes", async () => {
    const configStore = await daemonConfig({ codex: { env: { BASE: "on" } } });
    const draft: CustomProviderCliDraft = {
      mode: "create",
      providerId: "my-codex",
      extends: "codex",
      label: "My Codex",
      env: { FILE: "on" },
    };
    const results = await Promise.all([
      runCustomProviderCliOperation("save", draft, cliDependencies(configStore)),
      runCustomProviderCliOperation("save", draft, cliDependencies(configStore)),
    ]);
    expect(results).toEqual([{ status: "ok" }, { status: "invalid" }]);

    const edit = { mode: "edit", providerId: "my-codex" } as const;
    expect(
      await Promise.all([
        runCustomProviderCliOperation(
          "save",
          { ...edit, env: { FIRST: "one" } },
          cliDependencies(configStore),
        ),
        runCustomProviderCliOperation(
          "save",
          { ...edit, env: { SECOND: "two" } },
          cliDependencies(configStore),
        ),
      ]),
    ).toEqual([{ status: "ok" }, { status: "ok" }]);
    const persisted = await loadPersistedConfigAsync(root);
    expect(persisted.agents?.providers?.["my-codex"]?.env).toEqual({
      FILE: "on",
      FIRST: "one",
      SECOND: "two",
    });
    expect(
      await runCustomProviderCliOperation(
        "save",
        {
          ...edit,
          extends: "claude",
        },
        cliDependencies(configStore),
      ),
    ).toEqual({ status: "invalid" });

    await writeProviderConfig({ "my-codex": { extends: "claude", label: "Changed on disk" } });
    expect(
      await runCustomProviderCliOperation(
        "save",
        { ...edit, label: "Stale editor" },
        cliDependencies(configStore),
      ),
    ).toEqual({ status: "blocked", reason: "reload_required" });
    expect((await loadPersistedConfigAsync(root)).agents?.providers?.["my-codex"]).toEqual({
      extends: "claude",
      label: "Changed on disk",
    });
  });

  it("rejects launch edits after a metadata save preserved a divergent endpoint", async () => {
    const old = { extends: "codex", label: "Old", env: { OPENAI_BASE_URL: "https://old.example" } };
    const disk = { ...old, env: { OPENAI_BASE_URL: "https://new.example" } };
    const configStore = await daemonConfig({ derived: old });
    const deps = cliDependencies(configStore);
    const draft = { mode: "edit", providerId: "derived" } as const;
    await writeProviderConfig({ derived: disk });
    expect(
      await runCustomProviderCliOperation("save", { ...draft, label: "Renamed" }, deps),
    ).toEqual({ status: "ok" });
    expect(configStore.get().providers.derived).toEqual({ ...old, label: "Renamed" });
    expect(
      await runCustomProviderCliOperation("save", { ...draft, env: { OTHER: "on" } }, deps),
    ).toEqual({ status: "blocked", reason: "reload_required" });
    expect((await loadPersistedConfigAsync(root)).agents?.providers?.derived).toEqual({
      ...disk,
      label: "Renamed",
    });
    expect(configStore.get().providers.derived).toEqual({ ...old, label: "Renamed" });
  });

  it("rejects new ACP entries using a dedicated adapter ID and permits existing edits", async () => {
    const command = await makeCli("ok");
    const configStore = await daemonConfig({
      cursor: { extends: "acp", label: "Cursor", command },
    });
    const deps = cliDependencies(configStore);
    const draft = { ...acpDraft(command), providerId: "kiro" };
    expect(await runCustomProviderCliOperation("save", draft, deps)).toEqual({
      status: "invalid",
    });
    expect(
      await runCustomProviderCliOperation("save", { ...draft, extends: "codex" }, deps),
    ).toEqual({ status: "ok" });
    expect(
      await runCustomProviderCliOperation(
        "save",
        { mode: "edit", providerId: "cursor", extends: "acp", label: "Renamed Cursor" },
        deps,
      ),
    ).toEqual({ status: "ok" });
    expect(configStore.get().providers.cursor).toEqual({
      extends: "acp",
      label: "Renamed Cursor",
      command,
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid commands, builtin creation and plugin collisions", async () => {
    const configStore = await daemonConfig({
      "plugin-agent": { label: "Plugin collision", extends: "codex" },
    });
    const command = await makeCli("ok");
    const draft = acpDraft(command);
    const deps = {
      configStore,
      isRegisteredProvider: (id: string) => id === "external",
      isPluginProvider: (id: string) => id === "plugin-agent" || id === "plugin-only",
    };
    expect(
      await runCustomProviderCliOperation("locate", { ...draft, command: ["./agent"] }, deps),
    ).toEqual({ status: "invalid" });
    expect(
      await runCustomProviderCliOperation("save", { ...draft, providerId: "codex" }, deps),
    ).toEqual({ status: "invalid" });
    for (const providerId of ["external", "plugin-only"]) {
      expect(await runCustomProviderCliOperation("save", { ...draft, providerId }, deps)).toEqual({
        status: "invalid",
      });
    }
    expect(
      await runCustomProviderCliOperation(
        "save",
        {
          mode: "edit",
          providerId: "plugin-agent",
          label: "New label",
        },
        deps,
      ),
    ).toEqual({ status: "unsupported" });
    expect(
      await runCustomProviderCliOperation(
        "save",
        {
          mode: "create",
          providerId: "missing-command",
          extends: "acp",
          label: "Missing",
        },
        deps,
      ),
    ).toEqual({ status: "invalid" });
  });
});
