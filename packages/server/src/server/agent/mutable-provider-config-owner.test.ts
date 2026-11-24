import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";

import type { CustomProviderCliDraft, MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { loadConfig } from "../config.js";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { loadPersistedConfigAsync, type PersistedConfig } from "../persisted-config.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  FetchCatalogOptions,
} from "./agent-sdk-types.js";
import { attachMutableProviderConfigOwner } from "./mutable-provider-config-owner.js";
import {
  type ProviderSnapshotTransition,
  ProviderSnapshotManager,
} from "./provider-snapshot-manager.js";

const tempDirs: string[] = [];
const CONTROLLED_PROVIDERS = {
  claude: { enabled: false },
  codex: { enabled: true },
  copilot: { enabled: false },
  omp: { enabled: false },
  opencode: { enabled: false },
  pi: { enabled: false },
} as const;

interface Catalog {
  models: AgentModelDefinition[];
  modes: AgentMode[];
}

function controlledCodexClient(fetchCatalog: (options: FetchCatalogOptions) => Promise<Catalog>) {
  return {
    provider: "codex",
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    async createSession() {
      throw new Error("not implemented");
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
    isAvailable: async () => true,
    fetchCatalog,
  } satisfies AgentClient;
}

function catalog(modelId: string): Catalog {
  return {
    models: [{ provider: "codex", id: modelId, label: modelId }],
    modes: [],
  };
}

function recordCodexEvent(events: string[]): (transition: ProviderSnapshotTransition) => void {
  return ({ current }) => {
    const codex = current.records.find(({ entry }) => entry.provider === "codex")?.entry;
    events.push(`${codex?.status}:${codex?.models?.[0]?.id ?? "none"}`);
  };
}

function getCodexSnapshot(manager: ProviderSnapshotManager, cwd: string) {
  return manager.getSnapshot(cwd).records.find(({ entry }) => entry.provider === "codex")?.entry;
}

function mutableConfig(persisted: PersistedConfig): MutableDaemonConfig {
  return {
    relay: { enabled: false },
    mcp: { enabled: true, injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: CONTROLLED_PROVIDERS,
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    cors: { allowedOrigins: persisted.daemon?.cors?.allowedOrigins ?? [] },
    trustedProxies: ["loopback"],
    git: {
      maxProcessesPerSecond: persisted.daemon?.git?.maxProcessesPerSecond ?? 64,
      maxProcessConcurrency: persisted.daemon?.git?.maxProcessConcurrency ?? 8,
    },
    app: { baseUrl: persisted.app?.baseUrl ?? "https://app.paseo.sh" },
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { recursive: true, force: true });
});

describe("mutable provider config owner", () => {
  test("a read-only Session can locate a CLI and a manage refresh can retry failed discovery", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-custom-catalog-"));
    tempDirs.push(root);
    const script = path.join(root, "codex.mjs");
    writeFileSync(script, "process.exit(0);\n");
    let attempts = 0;
    let saved = false;
    const retryStarted = Promise.withResolvers<void>();
    const finishRetry = Promise.withResolvers<void>();
    const client = controlledCodexClient(async () => {
      if (saved && ++attempts === 1) throw new Error("Catalog temporarily unavailable");
      if (saved && attempts === 2) {
        retryStarted.resolve();
        await finishRetry.promise;
      }
      return catalog("example");
    });
    const listImportableSessions = vi.fn(async () => []);
    const codex = {
      ...client,
      capabilities: { ...client.capabilities, supportsSessionListing: true },
      listImportableSessions,
    };
    const daemon = await createTestPaseoDaemon({
      mcpEnabled: false,
      agentClients: { codex },
      providerOverrides: CONTROLLED_PROVIDERS,
    });
    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const reader = new DaemonClient({ url, sessionPermissions: ["daemon.read", "workspace.read"] });
    const manager = new DaemonClient({ url, sessionPermissions: ["daemon.read", "daemon.manage"] });
    const provider = "codex";
    const draft = {
      mode: "edit",
      providerId: provider,
      command: [process.execPath, script],
    } as const;
    const request = { ...draft, command: [...draft.command] };
    try {
      await Promise.all([reader.connect(), manager.connect()]);
      await manager.refreshProvidersSnapshot({ providers: [provider] });
      const getStatus = async () =>
        (await reader.getProvidersSnapshot()).entries.find((entry) => entry.provider === provider)
          ?.status;

      expect((await reader.locateCustomProviderCli(request)).result).toMatchObject({
        status: "ok",
      });
      expect((await manager.saveCustomProviderCli(request)).result).toMatchObject({ status: "ok" });
      saved = true;
      await Promise.all([
        reader.refreshProvidersSnapshot({ providers: [provider] }),
        reader.getDaemonStatus(),
        reader.getProviderDiagnostic(provider),
        reader.fetchRecentProviderSessions({ providers: [provider] }),
        reader.listProjectSuggestions({ providers: [provider] }),
      ]);
      expect(await getStatus()).toBe("unavailable");
      expect(attempts).toBe(0);
      expect(listImportableSessions).not.toHaveBeenCalled();

      await manager.refreshProvidersSnapshot({ providers: [provider] });
      expect(await getStatus()).toBe("error");
      expect(attempts).toBe(1);
      const retry = manager.refreshProvidersSnapshot({ providers: [provider] });
      await Promise.race([retryStarted.promise, retry]);
      await Promise.all([
        reader.refreshProvidersSnapshot({ providers: [provider] }),
        reader.fetchRecentProviderSessions({ providers: [provider] }),
      ]);
      expect(attempts).toBe(2);
      expect(listImportableSessions).not.toHaveBeenCalled();
      finishRetry.resolve();
      await retry;
      expect(await getStatus()).toBe("ready");
      expect(attempts).toBe(2);
      await Promise.all([
        reader.fetchRecentProviderSessions({ providers: [provider] }),
        reader.refreshProvidersSnapshot({ providers: [provider], cwd: daemon.paseoHome }),
        reader.getProvidersSnapshot({ cwd: daemon.paseoHome }),
      ]);
      expect(attempts).toBe(2);
      expect(listImportableSessions).not.toHaveBeenCalled();
    } finally {
      finishRetry.resolve();
      await Promise.all([reader.close(), manager.close()]);
      await daemon.close();
    }
  }, 20_000);

  test("managed refresh makes inherited built-ins selectable without granting ordinary catalog launches", async () => {
    const baseIds = ["claude", "opencode", "pi", "omp"];
    const root = mkdtempSync(path.join(tmpdir(), "paseo-inherited-catalog-"));
    tempDirs.push(root);
    vi.stubEnv("PASEO_HOME", root);
    onTestFinished(() => vi.unstubAllEnvs());
    const script = path.join(root, "provider.mjs");
    writeFileSync(script, "process.exit(0);\n");
    const clients = baseIds.map((base) => {
      const provider = `custom-${base}`;
      const beforeResumeSession = vi.fn().mockResolvedValue(undefined);
      const client = createTestAgentClient(provider, { beforeResumeSession });
      const fetchCatalog = vi.spyOn(client, "fetchCatalog");
      return { base, provider, client, fetchCatalog, beforeResumeSession };
    });
    const daemon = await createTestPaseoDaemon({
      mcpEnabled: false,
      agentClients: Object.fromEntries(clients.map(({ provider, client }) => [provider, client])),
      providerOverrides: { ...CONTROLLED_PROVIDERS, codex: { enabled: false } },
    });
    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const reader = new DaemonClient({ url, sessionPermissions: ["daemon.read", "workspace.read"] });
    const owner = new DaemonClient({ url });
    const workspace = daemon.staticDir;
    try {
      await Promise.all([reader.connect(), owner.connect()]);
      for (const { base, provider, fetchCatalog, beforeResumeSession } of clients) {
        expect(
          (
            await owner.saveCustomProviderCli({
              mode: "create",
              providerId: provider,
              extends: base,
              label: `Custom ${base}`,
              command: [process.execPath, script],
            })
          ).result,
        ).toMatchObject({ status: "ok" });
        const getWorkspaceEntry = async () =>
          (await reader.getProvidersSnapshot({ cwd: workspace })).entries.find(
            (entry) => entry.provider === provider,
          );
        expect(await getWorkspaceEntry()).toMatchObject({ status: "unavailable" });
        expect(fetchCatalog).not.toHaveBeenCalled();

        await owner.refreshProvidersSnapshot({ providers: [provider] });
        expect(fetchCatalog).toHaveBeenCalledTimes(1);
        expect(await getWorkspaceEntry()).toMatchObject({ enabled: true, status: "ready" });
        await reader.refreshProvidersSnapshot({ cwd: workspace, providers: [provider] });
        expect(fetchCatalog).toHaveBeenCalledTimes(1);

        const agent = await owner.createAgent({ cwd: workspace, provider });
        await daemon.daemon.agentManager.closeAgent(agent.id);
        await owner.refreshAgent(agent.id);
        expect(beforeResumeSession).toHaveBeenCalledTimes(1);
      }
    } finally {
      await Promise.all([reader.close(), owner.close()]);
      await daemon.close();
    }
  }, 20_000);

  test("workspace reads prefer their own catalog and discard both catalogs after launch changes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-provider-catalog-fallback-"));
    tempDirs.push(root);
    const script = path.join(root, "provider.mjs");
    const replacement = path.join(root, "replacement.mjs");
    for (const file of [script, replacement]) writeFileSync(file, "process.exit(0);\n");
    const command = [process.execPath, script];
    const provider = "inherited-catalog";
    const client = createTestAgentClient(provider);
    const fetchCatalog = vi.spyOn(client, "fetchCatalog").mockImplementation(async ({ scope }) => ({
      models: [{ provider, id: scope, label: scope }],
      modes: [],
    }));
    const inspect = vi.fn().mockResolvedValue({ status: "installed", version: "1.2.3" });
    const checkForUpdates = vi.fn().mockResolvedValue({ status: "current" });
    const daemon = await createTestPaseoDaemon({
      mcpEnabled: false,
      agentClients: {
        [provider]: Object.assign(client, { installation: { inspect, checkForUpdates } }),
      },
      providerOverrides: { ...CONTROLLED_PROVIDERS, codex: { enabled: false } },
    });
    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const reader = new DaemonClient({ url, sessionPermissions: ["daemon.read", "workspace.read"] });
    const owner = new DaemonClient({ url });
    const workspace = daemon.staticDir;
    const readEntry = async (cwd?: string) =>
      (await reader.getProvidersSnapshot({ cwd })).entries.find(
        (entry) => entry.provider === provider,
      );
    const save = async (draft: CustomProviderCliDraft) => {
      expect((await owner.saveCustomProviderCli(draft)).result).toMatchObject({ status: "ok" });
    };
    const refresh = async (cwd?: string) =>
      owner.refreshProvidersSnapshot({ cwd, providers: [provider] });
    const assertNoInstallationProbe = async () => {
      expect(await reader.inspectProviderInstallation(provider, { refresh: true })).toMatchObject({
        installation: {},
        error: null,
      });
      expect(await reader.checkProviderUpdates(provider, { refresh: true })).toMatchObject({
        updateCheck: null,
        error: null,
      });
      expect(inspect).not.toHaveBeenCalled();
      expect(checkForUpdates).not.toHaveBeenCalled();
    };
    try {
      await Promise.all([reader.connect(), owner.connect()]);
      await save({ mode: "edit", providerId: "codex", command });
      await save({
        mode: "create",
        providerId: provider,
        extends: "codex",
        label: "Inherited catalog",
      });
      expect(await readEntry(workspace)).toMatchObject({ status: "unavailable" });
      expect(fetchCatalog).not.toHaveBeenCalled();

      await refresh();
      expect(await readEntry(workspace)).toMatchObject({
        status: "ready",
        models: [{ id: "global" }],
      });
      expect(await readEntry(root)).toMatchObject({ status: "ready", models: [{ id: "global" }] });
      await reader.refreshProvidersSnapshot({ cwd: root, providers: [provider] });
      expect(fetchCatalog).toHaveBeenCalledTimes(1);
      await assertNoInstallationProbe();

      await refresh(workspace);
      await refresh();
      expect(await readEntry(workspace)).toMatchObject({
        status: "ready",
        models: [{ id: "workspace" }],
      });
      expect(await readEntry(root)).toMatchObject({ status: "ready", models: [{ id: "global" }] });
      const changes: CustomProviderCliDraft[] = [
        { mode: "edit", providerId: "codex", command: [process.execPath, replacement] },
        { mode: "edit", providerId: provider, env: { PASEO_CATALOG_TEST: "changed" } },
        { mode: "edit", providerId: provider, command },
      ];
      for (const draft of changes) {
        fetchCatalog.mockClear();
        await save(draft);
        for (const cwd of [undefined, workspace, root]) {
          expect(await readEntry(cwd)).toMatchObject({ status: "unavailable" });
        }
        expect(fetchCatalog).not.toHaveBeenCalled();
        await refresh();
        await refresh(workspace);
      }

      fetchCatalog.mockClear();
      expect(
        (await owner.testCustomProviderCli({ mode: "edit", providerId: provider })).result,
      ).toEqual({ status: "unsupported" });
      rmSync(script);
      await refresh();
      expect(await readEntry()).toMatchObject({
        status: "error",
        error: "Custom CLI discovery failed",
      });
      expect(await readEntry(root)).toMatchObject({ status: "unavailable" });
      expect(fetchCatalog).not.toHaveBeenCalled();
      await assertNoInstallationProbe();
    } finally {
      await Promise.all([reader.close(), owner.close()]);
      await daemon.close();
    }
  }, 20_000);

  test("installation reads reuse the authorized OpenCode version without launching it again", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-managed-installation-"));
    tempDirs.push(root);
    vi.stubEnv("PASEO_HOME", root);
    onTestFinished(() => vi.unstubAllEnvs());
    const script = path.join(root, "opencode.cjs");
    const marker = path.join(root, "invocations");
    writeFileSync(
      script,
      `
      const args = process.argv.slice(2);
      require("node:fs").appendFileSync(${JSON.stringify(marker)}, args[0] + "\\n");
      if (args[0] === "--version") {
        console.log("opencode 1.14.46");
      } else {
        const responses = {
          "/provider": { all: [{ id: "test", name: "Test", models: { model: { name: "Test Model" } } }], connected: ["test"] },
          "/agent": [{ name: "test", mode: "primary" }],
        };
        const server = require("node:http").createServer((req, res) => {
          const value = responses[req.url.split("?")[0]];
          res.writeHead(value === undefined ? 404 : 200, { "content-type": "application/json" });
          res.end(JSON.stringify(value ?? {}));
        });
        server.listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1", () =>
          console.log("server listening on http://127.0.0.1:" + server.address().port)
        );
      }
    `,
    );
    const daemon = await createTestPaseoDaemon({
      mcpEnabled: false,
      providerOverrides: { ...CONTROLLED_PROVIDERS, codex: { enabled: false } },
    });
    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const reader = new DaemonClient({ url, sessionPermissions: ["daemon.read"] });
    const owner = new DaemonClient({ url });
    const provider = "custom-opencode-version";
    const readInstallation = (refresh = false) =>
      reader.inspectProviderInstallation(provider, { refresh });
    try {
      await Promise.all([reader.connect(), owner.connect()]);
      expect(
        (
          await owner.saveCustomProviderCli({
            mode: "create",
            providerId: provider,
            extends: "opencode",
            label: "Custom OpenCode",
            command: [process.execPath, script],
            env: {
              XDG_CONFIG_HOME: root,
              XDG_STATE_HOME: root,
              PASEO_OPENCODE_SERVER_URL: "",
              OPENCODE_CONFIG_CONTENT: "{}",
            },
          })
        ).result,
      ).toMatchObject({ status: "ok" });
      const initial = await readInstallation(true);
      expect(initial).toMatchObject({
        installation: { installUrl: expect.any(String) },
        error: null,
      });
      expect(initial.installation?.inspection).toBeUndefined();
      expect(existsSync(marker)).toBe(false);

      await owner.refreshProvidersSnapshot({ providers: [provider] });
      expect(
        (await reader.getProvidersSnapshot()).entries.find((entry) => entry.provider === provider),
      ).toMatchObject({ status: "ready" });
      for (const refresh of [false, true]) {
        expect(await readInstallation(refresh)).toMatchObject({
          installation: { inspection: { status: "installed", version: "1.14.46" } },
          error: null,
        });
      }
      expect(await reader.checkProviderUpdates(provider, { refresh: true })).toMatchObject({
        updateCheck: null,
        error: null,
      });
      expect(readFileSync(marker, "utf8")).toBe("--version\nserve\n");

      const label = "Renamed OpenCode";
      expect(
        (await owner.saveCustomProviderCli({ mode: "edit", providerId: provider, label })).result,
      ).toMatchObject({ status: "ok" });
      expect(
        (await reader.getProvidersSnapshot()).entries.find((entry) => entry.provider === provider),
      ).toMatchObject({ status: "ready", label });
      expect(await readInstallation(true)).toMatchObject({
        installation: { inspection: { status: "installed", version: "1.14.46" } },
        error: null,
      });

      expect(
        (
          await owner.saveCustomProviderCli({
            mode: "edit",
            providerId: provider,
            env: { PASEO_VERSION_TEST: "changed" },
          })
        ).result,
      ).toMatchObject({ status: "ok" });
      expect((await readInstallation()).installation?.inspection).toBeUndefined();
      expect(readFileSync(marker, "utf8")).toBe("--version\nserve\n");
    } finally {
      await Promise.all([reader.close(), owner.close()]);
      await daemon.close();
    }
  }, 20_000);

  test("stored Session reads retain local history without reopening a form-managed CLI", async () => {
    const resumeSession = vi.fn(async () => undefined);
    const createSession = vi.fn(async () => undefined);
    const daemon = await createTestPaseoDaemon({
      mcpEnabled: false,
      agentClients: {
        codex: createTestAgentClient("codex", {
          beforeResumeSession: resumeSession,
          beforeCreateSession: createSession,
        }),
      },
      providerOverrides: CONTROLLED_PROVIDERS,
    });
    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const reader = new DaemonClient({ url, sessionPermissions: ["daemon.read", "workspace.read"] });
    const owner = new DaemonClient({
      url,
      sessionPermissions: ["daemon.read", "daemon.manage", "workspace.read", "workspace.write"],
    });
    const { agentManager, agentStorage } = daemon.daemon;
    const agentId = "00000000-0000-4000-8000-000000000711";
    const message = "Retained history for a closed test agent";
    try {
      await Promise.all([reader.connect(), owner.connect()]);
      await agentManager.createAgent({ provider: "codex", cwd: daemon.paseoHome }, agentId, {});
      await agentManager.appendTimelineItem(agentId, { type: "assistant_message", text: message });
      await agentManager.closeAgent(agentId);
      await agentManager.flush();
      await agentStorage.flush();
      expect((await agentStorage.get(agentId))?.persistence?.sessionId).toBeTruthy();
      expect(
        (
          await owner.saveCustomProviderCli({
            mode: "edit",
            providerId: "codex",
            command: [process.execPath],
          })
        ).result,
      ).toMatchObject({ status: "ok" });
      resumeSession.mockClear();
      createSession.mockClear();

      const [commands, timeline, search] = await Promise.all([
        reader.listCommands(agentId),
        reader.fetchAgentTimeline(agentId),
        reader.searchAgentTimeline({ agentId, query: "Retained history" }),
        reader.listAgentTimelinePrompts(agentId),
      ]);
      expect(commands).toMatchObject({ commands: [], error: null });
      expect(JSON.stringify(timeline)).toContain(message);
      expect(search.locations).toEqual([{ seq: 1, role: "assistant", count: 1 }]);
      expect(resumeSession).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();

      await owner.refreshAgent(agentId);
      expect(resumeSession).toHaveBeenCalledTimes(1);
      expect(agentManager.getAgent(agentId)).toBeDefined();
    } finally {
      await Promise.all([reader.close(), owner.close()]);
      await daemon.close();
    }
  }, 20_000);

  test("a custom CLI save rebases disk edits and defers the new catalog and its dependents", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-custom-cli-owner-"));
    tempDirs.push(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    const marker = path.join(paseoHome, "cli-started");
    const providers = {
      ...CONTROLLED_PROVIDERS,
      codex: { enabled: true, env: { REMOVE: "before", BOTH: "before" }, description: "Original" },
      inherited: { extends: "codex", label: "Inherited Codex" },
    };
    writeFileSync(configPath, JSON.stringify({ version: 1, agents: { providers } }));
    const store = new DaemonConfigStore(paseoHome, {
      ...mutableConfig({ version: 1 }),
      providers: {
        ...providers,
        codex: { ...providers.codex, env: { ...providers.codex.env, RUNTIME: "held" } },
      },
    });
    let checkLaunch = false;
    const fetchCatalog = async () => {
      if (checkLaunch) {
        execFileSync(process.execPath, [
          "-e",
          'require("node:fs").writeFileSync(process.argv[1], "started")',
          marker,
        ]);
      }
      return catalog("initial");
    };
    const inspect = vi.fn(async () => ({ status: "installed" as const, version: "1.2.3" }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: providers,
      extraClients: {
        codex: { ...controlledCodexClient(fetchCatalog), installation: { inspect } },
        inherited: controlledCodexClient(fetchCatalog),
      },
    });
    const unsubscribe = attachMutableProviderConfigOwner({
      store,
      providerSnapshotManager: manager,
      updateProviderRegistry: () => undefined,
    });
    try {
      await manager.refreshSettingsSnapshot({ providers: ["codex", "inherited"] });
      checkLaunch = true;
      const edited = {
        ...providers,
        codex: {
          ...providers.codex,
          description: "Edited on disk",
          env: { BOTH: "file", FILE: "held" },
        },
      };
      writeFileSync(configPath, JSON.stringify({ version: 1, agents: { providers: edited } }));
      await store.patchCustomProviderCli(async (_runtime, disk) => {
        expect(disk?.codex?.description).toBe("Edited on disk");
        return { providers: { codex: { command: [process.execPath], env: { UI: "written" } } } };
      });
      expect(store.get().providers.codex).toMatchObject({ description: "Edited on disk" });
      expect(store.get().providers.codex?.["env"]).toEqual({
        BOTH: "file",
        FILE: "held",
        RUNTIME: "held",
        UI: "written",
      });
      const persisted = await loadPersistedConfigAsync(paseoHome);
      expect(persisted.agents?.providers?.codex?.deferDiscovery).toBe(true);
      expect(persisted.agents?.providers?.codex?.env).toEqual({
        BOTH: "file",
        FILE: "held",
        UI: "written",
      });
      expect(
        manager
          .getSnapshot()
          .records.filter(({ entry }) => ["codex", "inherited"].includes(entry.provider))
          .map(({ entry }) => entry.status),
      ).toEqual(["unavailable", "unavailable"]);
      const cwd = path.join(paseoHome, "workspace");
      manager.getSnapshot(cwd);
      await manager.warmUpSnapshotForCwd({ cwd });
      await manager.refreshSnapshotForCwd({ cwd, providers: ["codex", "inherited"] });
      expect(await manager.getProvider({ cwd, provider: "inherited", wait: true })).toMatchObject({
        status: "unavailable",
      });
      expect(await manager.installations.inspect("codex")).toEqual({});
      expect(inspect).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(false);

      const restarted = new ProviderSnapshotManager({
        logger: createTestLogger(),
        providerOverrides: loadConfig(paseoHome).providerOverrides,
        extraClients: {
          codex: controlledCodexClient(fetchCatalog),
          inherited: controlledCodexClient(fetchCatalog),
        },
      });
      try {
        await restarted.refreshSettingsSnapshot({ providers: ["codex", "inherited"] });
        expect(restarted.isProviderDiscoveryDeferred("codex")).toBe(true);
        expect(restarted.isProviderDiscoveryDeferred("inherited")).toBe(true);
        expect(existsSync(marker)).toBe(false);
      } finally {
        restarted.destroy();
      }

      await manager.discoverDeferredProvider("codex", cwd, {
        kind: "refresh",
        prepare: async () => async (operation) => operation(),
      });
      expect(existsSync(marker)).toBe(true);
      expect(await manager.getProvider({ cwd, provider: "codex", wait: true })).toMatchObject({
        status: "ready",
      });
      expect(await manager.installations.inspect("codex")).toEqual({});
      expect(inspect).not.toHaveBeenCalled();
      expect(manager.isProviderDiscoveryDeferred("inherited")).toBe(true);
      await store.patchCustomProviderCli(async () => ({
        providers: { codex: { description: "Changed after discovery" } },
      }));
      expect(manager.isProviderDiscoveryDeferred("codex")).toBe(true);
      expect(
        manager.peekSnapshot(cwd)?.records.find(({ entry }) => entry.provider === "codex")?.entry,
      ).toMatchObject({ status: "ready", description: "Changed after discovery" });
    } finally {
      unsubscribe();
      manager.destroy();
    }
  });

  test.skipIf(process.platform === "win32")(
    "editing display text reuses the real catalog and clients for a hand-written launcher and its derived provider",
    async () => {
      const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-custom-cli-owner-"));
      tempDirs.push(paseoHome);
      const configPath = path.join(paseoHome, "config.json");
      const marker = path.join(paseoHome, "started");
      const cli = path.join(paseoHome, "acp.mjs");
      const fixture = new URL("./providers/test-utils/fake-acp-agent.mjs", import.meta.url);
      writeFileSync(
        cli,
        [
          'import { appendFileSync } from "node:fs";',
          `appendFileSync(${JSON.stringify(marker)}, "started\\n");`,
          `await import(${JSON.stringify(fixture.href)});`,
        ].join("\n"),
      );
      const command = [process.execPath, cli, "{}"];
      const providers = {
        ...CONTROLLED_PROVIDERS,
        codex: { enabled: false },
        copilot: { command },
        inherited: { extends: "copilot", label: "Inherited" },
      };
      writeFileSync(configPath, JSON.stringify({ version: 1, agents: { providers } }));
      const store = new DaemonConfigStore(paseoHome, { ...mutableConfig({}), providers });
      const manager = new ProviderSnapshotManager({
        logger: createTestLogger(),
        providerOverrides: providers,
      });
      const unsubscribe = attachMutableProviderConfigOwner({
        store,
        providerSnapshotManager: manager,
        updateProviderRegistry: () => undefined,
      });
      try {
        await manager.refreshSettingsSnapshot({ providers: ["copilot", "inherited"] });
        const before = manager.getAgentManagerProviderState().clients;
        const initial = manager
          .peekSnapshot()!
          .records.filter(({ entry }) => ["copilot", "inherited"].includes(entry.provider));
        expect(initial.map(({ entry }) => entry.status)).toEqual(["ready", "ready"]);
        expect(existsSync(marker)).toBe(true);
        rmSync(marker);
        await store.patchCustomProviderCli(async () => ({
          providers: {
            copilot: { label: "New label", description: "New description" },
            inherited: { description: "New inherited description" },
          },
        }));
        expect(manager.isProviderDiscoveryDeferred("copilot")).toBe(false);
        expect((await loadPersistedConfigAsync(paseoHome)).agents?.providers?.copilot).toEqual({
          command,
          label: "New label",
          description: "New description",
        });
        const after = manager.getAgentManagerProviderState().clients;
        expect(after.copilot).toBe(before.copilot);
        expect(after.inherited).toBe(before.inherited);
        expect(manager.peekSnapshot()?.records.map(({ entry }) => entry)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ provider: "copilot", status: "ready", label: "New label" }),
            expect.objectContaining({
              provider: "inherited",
              status: "ready",
              description: "New inherited description",
            }),
          ]),
        );
        await manager.warmUpSnapshotForCwd({ providers: ["copilot", "inherited"] });
        expect(existsSync(marker)).toBe(false);
      } finally {
        unsubscribe();
        manager.destroy();
      }
    },
  );

  test
    .skipIf(process.platform === "win32")
    .each([
      "direct npx",
      "PATH alias to npx",
      "absolute alias to uvx",
      "retargeted alias to npx",
      "relative interpreter script",
      "interpreter option before script",
      "absolute interpreter with shebang option",
      "env shebang with a bare interpreter",
      "env split string with shebang option",
      "symlinked env with shebang option",
    ] as const)(
    "reads a legacy provider configured with %s without launching it and still opens an explicit agent",
    async (kind) => {
      const root = mkdtempSync(path.join(tmpdir(), "paseo-legacy-launcher-"));
      tempDirs.push(root);
      const marker = path.join(root, "started");
      const ordinaryMarker = path.join(root, "ordinary-started");
      const isRelativeScript = kind === "relative interpreter script";
      const isInterpreterScript = isRelativeScript || kind === "interpreter option before script";
      const envAlias = path.join(root, "env-alias");
      const node = path.basename(process.execPath);
      const shebangs: Partial<Record<typeof kind, string>> = {
        "absolute interpreter with shebang option": `${process.execPath} --no-warnings`,
        "env shebang with a bare interpreter": `/usr/bin/env ${node}`,
        "env split string with shebang option": `/usr/bin/env -S ${node} --no-warnings`,
        "symlinked env with shebang option": `${envAlias} -S ${node} --no-warnings`,
      };
      const shebang = shebangs[kind];
      const hasCustomShebang = shebang !== undefined;
      if (kind === "symlinked env with shebang option") symlinkSync("/usr/bin/env", envAlias);
      const runnerName = kind === "absolute alias to uvx" ? "uvx" : "npx";
      const launchFile = path.join(
        root,
        isInterpreterScript || hasCustomShebang ? "agent.cjs" : runnerName,
      );
      const fixture = new URL("./providers/test-utils/fake-acp-agent.mjs", import.meta.url);
      const writeLauncher = (file: string, launched: string, interpreter = process.execPath) =>
        writeFileSync(
          file,
          [
            `#!${interpreter}`,
            `require("node:fs").appendFileSync(${JSON.stringify(launched)}, "started\\n");`,
            'process.argv[2] = "{}";',
            `void import(${JSON.stringify(fixture.href)});`,
            "",
          ].join("\n"),
          { mode: 0o700 },
        );
      writeLauncher(launchFile, marker, shebang);
      const alias = path.join(root, "legacy-cli");
      if (kind === "retargeted alias to npx") {
        const ordinary = path.join(root, "ordinary-cli");
        writeLauncher(ordinary, ordinaryMarker);
        symlinkSync(path.basename(ordinary), alias);
      } else if (kind === "PATH alias to npx" || kind === "absolute alias to uvx") {
        symlinkSync(path.basename(launchFile), alias);
      }
      let command = launchFile;
      if (kind === "PATH alias to npx") command = path.basename(alias);
      if (kind === "absolute alias to uvx" || kind === "retargeted alias to npx") command = alias;
      const provider = "legacy-runner";
      const daemon = await createTestPaseoDaemon({
        mcpEnabled: false,
        providerOverrides: {
          ...CONTROLLED_PROVIDERS,
          codex: { enabled: false },
          [provider]: {
            extends: "acp",
            label: "Legacy runner",
            command: isInterpreterScript
              ? [
                  process.execPath,
                  ...(isRelativeScript
                    ? [path.relative(process.cwd(), launchFile)]
                    : ["--no-warnings", launchFile]),
                  "--acp",
                ]
              : [command, "fake-package", "--acp"],
            env: { PATH: [root, path.dirname(process.execPath)].join(path.delimiter) },
          },
        },
      });
      const url = `ws://127.0.0.1:${daemon.port}/ws`;
      const reader = new DaemonClient({
        url,
        sessionPermissions: ["daemon.read", "workspace.read"],
      });
      const owner = new DaemonClient({ url });
      try {
        await Promise.all([reader.connect(), owner.connect()]);
        if (isInterpreterScript || hasCustomShebang) {
          const diagnostic = await reader.getProviderDiagnostic(provider);
          expect(diagnostic.diagnostic).toContain("CLI is checked when opening an agent");
          expect(existsSync(marker)).toBe(false);
        }
        if (kind === "retargeted alias to npx") {
          const refresh = () => reader.refreshProvidersSnapshot({ providers: [provider] });
          expect((await refresh()).acknowledged).toBe(true);
          expect(readFileSync(ordinaryMarker, "utf8")).toContain("started\n");
          symlinkSync(path.basename(launchFile), alias + ".next");
          renameSync(alias + ".next", alias);
          await reader.inspectProviderInstallation(provider, { refresh: true });
          await reader.listAvailableProviders();
          expect(existsSync(marker)).toBe(false);
          expect((await refresh()).acknowledged).toBe(true);
        }
        const expected = { provider, status: "ready", models: [] };
        expect((await reader.getProvidersSnapshot()).entries).toContainEqual(
          expect.objectContaining(expected),
        );
        const [workspace, diagnostic, installation, updates, refreshed] = await Promise.all([
          reader.getProvidersSnapshot({ cwd: daemon.staticDir }),
          reader.getProviderDiagnostic(provider),
          reader.inspectProviderInstallation(provider, { refresh: true }),
          reader.checkProviderUpdates(provider, { refresh: true }),
          reader.refreshProvidersSnapshot({ providers: [provider] }),
          reader.getDaemonStatus(),
          reader.listAvailableProviders(),
          reader.fetchRecentProviderSessions({ providers: [provider] }),
          reader.listProjectSuggestions({ providers: [provider] }),
        ]);
        expect(workspace.entries).toContainEqual(expect.objectContaining(expected));
        expect(refreshed.acknowledged).toBe(true);
        expect(diagnostic.diagnostic).toContain("CLI is checked when opening an agent");
        expect(installation.installation?.inspection).toBeUndefined();
        expect(updates.updateCheck).toBeNull();
        expect(existsSync(marker)).toBe(false);

        expect((await owner.refreshProvidersSnapshot({ providers: [provider] })).acknowledged).toBe(
          true,
        );
        expect(existsSync(marker)).toBe(false);
        const agent = await owner.createAgent({
          cwd: isRelativeScript ? process.cwd() : daemon.staticDir,
          provider,
        });
        expect(agent.provider).toBe(provider);
        const invocations = readFileSync(marker, "utf8");
        expect(invocations).toContain("started\n");
        expect(await owner.listCommands(agent.id)).toMatchObject({ commands: [], error: null });
        expect(readFileSync(marker, "utf8")).toBe(invocations);
      } finally {
        await Promise.all([reader.close(), owner.close()]);
        await daemon.close();
      }
    },
    20_000,
  );

  test("a real custom ACP failure stays out of Session snapshots, diagnostics, and logs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-custom-acp-error-"));
    tempDirs.push(root);
    const marker = path.join(root, "started");
    const secret = "fixture-acp-stderr-only";
    const script = path.join(root, "acp.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync, writeSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(marker)}, "started\\n");`,
        "writeSync(2, process.env.PASEO_TEST_ACP_SECRET);",
        "process.exit(1);",
      ].join("\n"),
    );
    const logs: string[] = [];
    const daemon = await createTestPaseoDaemon({
      mcpEnabled: false,
      providerOverrides: { ...CONTROLLED_PROVIDERS, codex: { enabled: false } },
      logger: pino({ level: "trace" }, { write: (line) => logs.push(line) }),
    });
    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const reader = new DaemonClient({ url, sessionPermissions: ["daemon.read"] });
    const manager = new DaemonClient({ url, sessionPermissions: ["daemon.read", "daemon.manage"] });
    const provider = "failed-acp";
    try {
      await Promise.all([reader.connect(), manager.connect()]);
      expect(
        (
          await manager.saveCustomProviderCli({
            mode: "create",
            providerId: provider,
            extends: "acp",
            label: "Failed ACP",
            command: [process.execPath, script],
            env: { PASEO_TEST_ACP_SECRET: secret },
          })
        ).result,
      ).toMatchObject({ status: "ok" });
      expect(existsSync(marker)).toBe(false);
      await manager.refreshProvidersSnapshot({ providers: [provider] });
      expect(existsSync(marker)).toBe(true);
      const snapshot = await reader.getProvidersSnapshot();
      expect(snapshot.entries.find((entry) => entry.provider === provider)).toMatchObject({
        status: "error",
        error: "Custom CLI discovery failed",
      });
      const diagnostic = await reader.getProviderDiagnostic(provider);
      expect(diagnostic.diagnostic).toContain("Custom CLI discovery failed");
      expect(JSON.stringify({ snapshot, diagnostic, logs })).not.toContain(secret);
    } finally {
      await Promise.all([reader.close(), manager.close()]);
      await daemon.close();
    }
  }, 20_000);

  test("rejects stale provider identity before replacing runtime or disk config", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-custom-cli-owner-"));
    tempDirs.push(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    const config = (extendsId: string) => ({
      version: 1,
      agents: { providers: { custom: { extends: extendsId, label: "Custom" } } },
    });
    writeFileSync(configPath, JSON.stringify(config("codex")));
    const store = new DaemonConfigStore(paseoHome, {
      ...mutableConfig({ version: 1 }),
      providers: { custom: { extends: "codex", label: "Custom" } },
    });
    writeFileSync(configPath, JSON.stringify(config("claude")));
    await expect(
      store.patchCustomProviderCli(async () => ({ providers: { custom: { label: "Rejected" } } })),
    ).rejects.toThrow("Provider identity differs");
    expect(store.get().providers.custom).toEqual({ extends: "codex", label: "Custom" });
    expect((await loadPersistedConfigAsync(paseoHome)).agents?.providers?.custom).toEqual({
      extends: "claude",
      label: "Custom",
    });
  });

  test("rejects an intervening file edit and rolls back an unsuccessful apply", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-custom-cli-owner-"));
    tempDirs.push(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    const config = (label: string) => ({ version: 1, agents: { providers: { codex: { label } } } });
    writeFileSync(configPath, JSON.stringify(config("Initial")));
    const store = new DaemonConfigStore(paseoHome, {
      ...mutableConfig({ version: 1 }),
      providers: { codex: { label: "Initial" } },
    });
    const patch = { providers: { codex: { label: "Submitted" } } };
    await expect(
      store.patchCustomProviderCli(async () => {
        writeFileSync(configPath, JSON.stringify(config("Edited while validating")));
        return patch;
      }),
    ).rejects.toThrow("Daemon config changed on disk");
    expect((await loadPersistedConfigAsync(paseoHome)).agents?.providers?.codex).toEqual({
      label: "Edited while validating",
    });

    store.onApply(() => {
      throw new Error("fake-secret-from-apply");
    });
    const safeError = await store
      .patchCustomProviderCli(async () => patch)
      .catch((error: unknown) => error);
    expect(safeError).toMatchObject({ message: "Failed to save custom provider CLI" });
    expect((await loadPersistedConfigAsync(paseoHome)).agents?.providers?.codex).toEqual({
      label: "Edited while validating",
    });
    expect(store.get().providers.codex).toEqual({ label: "Initial" });
  });

  test.each(["create", "edit"])("checks the inherited base during custom CLI %s", async (mode) => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-custom-cli-owner-"));
    tempDirs.push(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    const inherited = { extends: "codex", label: "Inherited" };
    const providers = {
      codex: { command: ["before"] },
      ...(mode === "edit" ? { inherited } : {}),
    };
    writeFileSync(configPath, JSON.stringify({ version: 1, agents: { providers } }));
    const store = new DaemonConfigStore(paseoHome, { ...mutableConfig({ version: 1 }), providers });

    await expect(
      store.patchCustomProviderCli(async (_runtime, disk) => {
        expect(disk?.codex?.command).toEqual(["before"]);
        const changed = { ...providers, codex: { command: ["after"] } };
        writeFileSync(configPath, JSON.stringify({ version: 1, agents: { providers: changed } }));
        return {
          providers: { inherited: mode === "create" ? inherited : { description: "Edited" } },
        };
      }),
    ).rejects.toThrow("Daemon config changed on disk");

    expect((await loadPersistedConfigAsync(paseoHome)).agents?.providers).toEqual({
      ...providers,
      codex: { command: ["after"] },
    });
    expect(store.get().providers).toEqual(providers);
  });

  test("retains unrelated file edits made while validating the custom CLI", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-custom-cli-owner-"));
    tempDirs.push(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    const providers = { codex: { label: "Initial" }, claude: { label: "Other" } };
    writeFileSync(configPath, JSON.stringify({ version: 1, agents: { providers } }));
    const store = new DaemonConfigStore(paseoHome, { ...mutableConfig({ version: 1 }), providers });
    const app = { baseUrl: "https://edited.example.test" };

    await store.patchCustomProviderCli(async () => {
      const changed = { ...providers, claude: { label: "Hand edited" } };
      writeFileSync(
        configPath,
        JSON.stringify({ version: 1, app, agents: { providers: changed } }),
      );
      return { providers: { codex: { label: "Submitted" } } };
    });

    expect(await loadPersistedConfigAsync(paseoHome)).toMatchObject({
      app,
      agents: { providers: { codex: { label: "Submitted" }, claude: { label: "Hand edited" } } },
    });
    expect(store.get().providers.claude).toEqual(providers.claude);
  });

  test("publishes provider changes after commit and emits nothing on rollback", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-provider-config-owner-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, mutableConfig({ version: 1 }));
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: CONTROLLED_PROVIDERS,
      extraClients: { codex: controlledCodexClient(async () => catalog("initial")) },
    });
    const cwd = path.resolve("/tmp/provider-config-owner");
    await manager.refreshSnapshotForCwd({ cwd });
    const events: string[] = [];
    manager.on("change", ({ current }) => events.push(current.cwd));
    let agentManagerState = manager.getAgentManagerProviderState();
    const unsubscribe = attachMutableProviderConfigOwner({
      store,
      providerSnapshotManager: manager,
      updateProviderRegistry: (state) => {
        agentManagerState = state;
      },
    });
    const unsubscribeTimingCheck = store.onApply(() => {
      expect(events).toEqual([]);
      return () => undefined;
    });

    try {
      await store.patch({ providers: { codex: { enabled: false } } });
      expect(events).toEqual([cwd]);
      expect(agentManagerState.providerDefinitions.codex).toMatchObject({ enabled: false });

      events.length = 0;
      const unsubscribeFailure = store.onApply(() => {
        throw new Error("later owner failed");
      });
      await expect(store.patch({ providers: { codex: { enabled: true } } })).rejects.toThrow(
        "later owner failed",
      );
      unsubscribeFailure();

      expect(events).toEqual([]);
      expect(manager.getAgentManagerProviderState().providerDefinitions.codex).toMatchObject({
        enabled: false,
      });
      expect(agentManagerState.providerDefinitions.codex).toMatchObject({ enabled: false });
    } finally {
      unsubscribeTimingCheck();
      unsubscribe();
      manager.destroy();
    }
  });

  test("does no provider work for unrelated CORS, Git, and app URL reloads", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-provider-config-owner-"));
    tempDirs.push(paseoHome);
    const initial: PersistedConfig = {
      version: 1,
      daemon: {
        cors: { allowedOrigins: ["https://before.example.test"] },
        git: { maxProcessesPerSecond: 64, maxProcessConcurrency: 8 },
      },
      app: { baseUrl: "https://before.example.test" },
    };
    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(configPath, `${JSON.stringify(initial, null, 2)}\n`, "utf-8");
    const store = new DaemonConfigStore(paseoHome, mutableConfig(initial), undefined, {
      startupPersisted: initial,
      reloadSource: {
        resolve: (persisted) => ({
          mutable: mutableConfig(persisted),
          overrideControlledPaths: [],
        }),
      },
    });
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: CONTROLLED_PROVIDERS,
      extraClients: { codex: controlledCodexClient(async () => catalog("initial")) },
    });
    await manager.refreshSnapshotForCwd({ cwd: "/tmp/provider-config-owner" });
    const events: string[] = [];
    manager.on("change", ({ current }) => events.push(current.cwd));
    let registryUpdates = 0;
    const unsubscribe = attachMutableProviderConfigOwner({
      store,
      providerSnapshotManager: manager,
      updateProviderRegistry: () => {
        registryUpdates += 1;
      },
    });

    try {
      const reloaded: PersistedConfig = {
        ...initial,
        daemon: {
          ...initial.daemon,
          cors: { allowedOrigins: ["https://after.example.test"] },
          git: { maxProcessesPerSecond: 5, maxProcessConcurrency: 1 },
        },
        app: { baseUrl: "https://after.example.test" },
      };
      writeFileSync(configPath, `${JSON.stringify(reloaded, null, 2)}\n`, "utf-8");

      expect((await store.reload()).appliedPaths).toEqual([
        "app.baseUrl",
        "daemon.cors.allowedOrigins",
        "daemon.git.maxProcessConcurrency",
        "daemon.git.maxProcessesPerSecond",
      ]);
      expect(events).toEqual([]);
      expect(registryUpdates).toBe(0);
      expect(manager.getAgentManagerProviderState().providerDefinitions.codex).toMatchObject({
        enabled: true,
      });
    } finally {
      unsubscribe();
      manager.destroy();
    }
  });

  test("replaces an in-flight catalog after provider config commits", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-provider-config-owner-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, mutableConfig({ version: 1 }));
    const catalogResolvers: Array<(value: Catalog) => void> = [];
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: CONTROLLED_PROVIDERS,
      extraClients: {
        codex: controlledCodexClient(
          () => new Promise((resolve) => catalogResolvers.push(resolve)),
        ),
      },
    });
    const cwd = path.resolve("/tmp/provider-config-commit");
    const events: string[] = [];
    manager.on("change", recordCodexEvent(events));
    const unsubscribe = attachMutableProviderConfigOwner({
      store,
      providerSnapshotManager: manager,
      updateProviderRegistry: () => undefined,
    });

    try {
      const originalRead = manager.getProvider({ cwd, provider: "codex", wait: true });
      await vi.waitFor(() => expect(catalogResolvers).toHaveLength(1));
      expect(events).toEqual([]);

      await store.patch({
        providers: { codex: { enabled: true, env: { TEST_LAUNCH_SETTING: "updated" } } },
      });
      await vi.waitFor(() => expect(catalogResolvers).toHaveLength(2));
      expect(events).toEqual([]);

      catalogResolvers[0]?.(catalog("stale-model"));
      await originalRead;
      expect(events).toEqual([]);

      catalogResolvers[1]?.(catalog("current-model"));
      await vi.waitFor(() =>
        expect(getCodexSnapshot(manager, cwd)).toMatchObject({
          status: "ready",
          models: [{ id: "current-model" }],
        }),
      );
      expect(events).toEqual(["ready:current-model"]);
    } finally {
      unsubscribe();
      manager.destroy();
    }
  });

  test("lets the original in-flight catalog publish after provider config rolls back", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-provider-config-owner-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, mutableConfig({ version: 1 }));
    const catalogResolvers: Array<(value: Catalog) => void> = [];
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: CONTROLLED_PROVIDERS,
      extraClients: {
        codex: controlledCodexClient(
          () => new Promise((resolve) => catalogResolvers.push(resolve)),
        ),
      },
    });
    const cwd = path.resolve("/tmp/provider-config-rollback");
    const events: string[] = [];
    manager.on("change", recordCodexEvent(events));
    const previousState = manager.getAgentManagerProviderState();
    let agentManagerState = previousState;
    const unsubscribe = attachMutableProviderConfigOwner({
      store,
      providerSnapshotManager: manager,
      updateProviderRegistry: (state) => {
        agentManagerState = state;
      },
    });
    const observedDuringApply: Array<{
      label: string;
      snapshot: ReturnType<ProviderSnapshotManager["getSnapshot"]>;
    }> = [];
    const unsubscribeFailure = store.onApply(() => {
      observedDuringApply.push({
        label: manager.getProviderLabel("codex"),
        snapshot: manager.getSnapshot(cwd),
      });
      throw new Error("later owner failed");
    });

    try {
      const originalRead = manager.getProvider({ cwd, provider: "codex", wait: true });
      await vi.waitFor(() => expect(catalogResolvers).toHaveLength(1));
      expect(events).toEqual([]);

      const before = manager.getSnapshot(cwd);
      await expect(
        store.patch({ providers: { codex: { enabled: true, label: "Rejected Codex" } } }),
      ).rejects.toThrow("later owner failed");
      expect(events).toEqual([]);
      expect(observedDuringApply).toEqual([{ label: "Codex", snapshot: before }]);
      expect(observedDuringApply[0]!.snapshot).toBe(before);
      expect(manager.getSnapshot(cwd)).toBe(before);
      expect(agentManagerState).toEqual(previousState);
      expect(agentManagerState.clients.codex).toBe(previousState.clients.codex);

      catalogResolvers[0]?.(catalog("original-model"));
      await expect(originalRead).resolves.toMatchObject({
        status: "ready",
        models: [{ id: "original-model" }],
      });
      expect(getCodexSnapshot(manager, cwd)).toMatchObject({
        status: "ready",
        models: [{ id: "original-model" }],
      });
      expect(events).toEqual(["ready:original-model"]);
      expect(catalogResolvers).toHaveLength(1);
    } finally {
      unsubscribeFailure();
      unsubscribe();
      manager.destroy();
    }
  });
});
