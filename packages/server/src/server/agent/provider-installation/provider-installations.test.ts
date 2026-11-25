import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { AgentManager } from "../agent-manager.js";
import { createTestAgentClient } from "../../test-utils/fake-agent-client.js";
import {
  acquireInstallationProcess,
  installationActivity,
  InstallationActivity,
} from "./installation-activity.js";
import {
  acquireApprovedUpdateFileLock,
  acquireProviderAgentFileTicket,
  acquireProviderUpdateFileLock,
  findInstallationLaunchPath,
  supportsHostApprovedProviderUpdates,
} from "./installation-target.js";
import type {
  ProviderEvent,
  ProviderInstallation,
  ProviderInstallationContext,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type {
  ProviderInstallationUpdate,
  ProviderInstallationUpdateProgress,
} from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import type { AgentClient, AgentClientInstallation } from "../agent-sdk-types.js";
import {
  formatApprovedProviderUpdaterPlansJson,
  LOCAL_UPDATER_PLANS_FILENAME,
  type LocalFileIdentity,
} from "./local-updater-plan-store.js";
import { runCustomProviderCliOperation } from "../custom-provider-cli.js";
import { attachMutableProviderConfigOwner } from "../mutable-provider-config-owner.js";
import { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { runUpdateCommand } from "../providers/update-command.js";
import {
  ProviderInstallations,
  ProviderUpdateCleanupError,
  type ProviderUpdateEvent,
} from "./provider-installations.js";

const fileLockFixture = vi.hoisted(() => ({ directory: "" }));
vi.mock("./installation-target.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./installation-target.js")>();
  const account = () => ({ directory: fileLockFixture.directory, uid: process.geteuid!() });
  return {
    ...actual,
    acquireProviderUpdateFileLock: vi.fn(() => actual.acquireProviderUpdateFileLock(account())),
    acquireApprovedUpdateFileLock: vi.fn(() => actual.acquireApprovedUpdateFileLock(account())),
    acquireProviderAgentFileTicket: vi.fn(() => actual.acquireProviderAgentFileTicket(account())),
  };
});

beforeEach(async () => {
  fileLockFixture.directory = await mkdtemp(path.join(tmpdir(), "paseo-update-account-"));
  vi.mocked(acquireProviderUpdateFileLock).mockClear();
  vi.mocked(acquireApprovedUpdateFileLock).mockClear();
  vi.mocked(acquireProviderAgentFileTicket).mockClear();
});

afterEach(async () => {
  await rm(fileLockFixture.directory, { recursive: true, force: true });
});

const OPAQUE_VERSION = "  v1.2.3-beta+weird (build 7)\n";
const MISSING_COMMAND = "paseo-provider-installation-missing-binary";
const OPAQUE_VERSIONS = ["v9-nightly+abc", "  2.0 (LTS)\n"];
const OPAQUE_MESSAGE = "  Restart to finish updating\n";

async function localFileIdentity(file: string): Promise<LocalFileIdentity> {
  const value = await stat(file, { bigint: true });
  return {
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    mode: Number(value.mode & 0o7777n),
    uid: Number(value.uid),
    gid: Number(value.gid),
    size: value.size.toString(),
    mtimeNs: value.mtimeNs.toString(),
    ctimeNs: value.ctimeNs.toString(),
  };
}

function pluginProvider(
  installation: ProviderInstallation | undefined,
  command: readonly [string, ...string[]] = [process.execPath],
): ProviderRegistration {
  return {
    id: "installation-plugin",
    label: "Installation plugin",
    command,
    installation,
    async connect() {
      let listener: ((event: ProviderEvent) => void) | undefined;
      return {
        version: 1,
        capabilities: [],
        async send(input) {
          if (input.type === "catalog")
            listener?.({
              type: "catalog",
              requestId: input.requestId,
              catalog: { models: [{ id: "model", label: "Model" }], modes: [] },
            });
        },
        onEvent(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        async close() {},
      };
    },
  };
}

function builtinClient(installation: AgentClientInstallation | undefined): AgentClient {
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
    installation,
    async createSession() {
      throw new Error("not opened by this test");
    },
    async resumeSession() {
      throw new Error("not opened by this test");
    },
    async fetchCatalog() {
      return { models: [], modes: [] };
    },
    async isAvailable() {
      return true;
    },
  };
}

function managerWith(input: { plugin?: ProviderRegistration; codex?: AgentClient }) {
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: input.codex ? { codex: input.codex } : {},
  });
  if (input.plugin) manager.replacePluginProviders([input.plugin]);
  return manager;
}

describe("provider installation", () => {
  test("returns static installation metadata for a saved CLI and its derivative without starting either", async () => {
    const providerOverrides = { inherited: { extends: "codex", label: "Inherited Codex" } };
    const manager = new ProviderSnapshotManager({ logger: createTestLogger(), providerOverrides });
    const root = await mkdtemp(path.join(tmpdir(), "paseo-custom-cli-installation-"));
    const script = path.join(root, "cli.cjs");
    const marker = path.join(root, "cli-started");
    const store = new DaemonConfigStore(root, {
      mcp: { injectIntoAgents: false },
      providers: providerOverrides,
      browserTools: { enabled: false },
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    const detach = attachMutableProviderConfigOwner({
      store,
      providerSnapshotManager: manager,
      updateProviderRegistry: () => undefined,
    });
    const fetchRelease = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"));
    try {
      await writeFile(
        script,
        'require("node:fs").writeFileSync(process.argv[2], "started"); console.log("codex-cli 1.2.3");',
      );
      await writeFile(
        path.join(root, "config.json"),
        JSON.stringify({ version: 1, agents: { providers: providerOverrides } }),
      );
      await expect(
        runCustomProviderCliOperation(
          "save",
          { mode: "edit", providerId: "codex", command: [process.execPath, script, marker] },
          {
            configStore: store,
            isRegisteredProvider: (id) => manager.hasProvider(id),
            isPluginProvider: (id) => manager.isPluginProvider(id),
          },
        ),
      ).resolves.toEqual({ status: "ok" });

      const { installations } = manager;
      for (const provider of ["codex", "inherited"]) {
        for (const refresh of [false, true]) {
          const options = { refresh };
          const [installation, updateCheck] = await Promise.all([
            installations.inspect(provider, options),
            installations.checkForUpdates(provider, options),
          ]);
          expect(installation).toEqual({
            installUrl: expect.stringMatching(/^https:/u),
            updateUrl: expect.stringMatching(/^https:/u),
          });
          expect(updateCheck).toBeNull();
        }
      }
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fetchRelease).not.toHaveBeenCalled();
      expect(() => installations.update("codex")).toThrow("using its original installer");
    } finally {
      fetchRelease.mockRestore();
      detach();
      manager.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("exposes links and lets the plugin report not installed when its executable is missing", async () => {
    const contexts: ProviderInstallationContext[] = [];
    const manager = managerWith({
      plugin: pluginProvider(
        {
          installUrl: "https://example.com/install",
          updateUrl: "https://example.com/update",
          async inspect(context) {
            contexts.push(context);
            return context.launch?.resolved ? { status: "installed" } : { status: "not_installed" };
          },
        },
        [MISSING_COMMAND, "serve"],
      ),
    });
    try {
      await expect(manager.installations.inspect("installation-plugin")).resolves.toEqual({
        installUrl: "https://example.com/install",
        updateUrl: "https://example.com/update",
        inspection: { status: "not_installed" },
      });
      expect(contexts[0]?.launch).toEqual({
        command: MISSING_COMMAND,
        args: ["serve"],
        env: expect.objectContaining({ PATH: expect.any(String) }),
        resolved: false,
      });
    } finally {
      manager.destroy();
    }
  });

  test.each([
    {
      name: "plugin",
      manager: () =>
        managerWith({
          plugin: pluginProvider({
            installUrl: "https://example.com/install",
            async inspect({ launch }) {
              if (!launch?.resolved || launch.command !== process.execPath)
                throw new Error("Unexpected launch");
              return { status: "installed", version: OPAQUE_VERSION };
            },
          }),
        }),
      provider: "installation-plugin",
    },
    {
      name: "built-in",
      manager: () =>
        managerWith({
          codex: builtinClient({
            installUrl: "https://example.com/install",
            async inspect() {
              return { status: "installed", version: OPAQUE_VERSION };
            },
          }),
        }),
      provider: "codex",
    },
  ])("returns a $name provider's version string unchanged", async ({ manager, provider }) => {
    const providers = manager();
    try {
      await expect(providers.installations.inspect(provider)).resolves.toEqual({
        installUrl: "https://example.com/install",
        inspection: { status: "installed", version: OPAQUE_VERSION },
      });
    } finally {
      providers.destroy();
    }
  });

  test("keeps links and reports the failure when inspect throws", async () => {
    const manager = managerWith({
      plugin: pluginProvider({
        installUrl: "https://example.com/install",
        async inspect() {
          throw new Error("version probe exploded");
        },
      }),
    });
    try {
      await expect(manager.installations.inspect("installation-plugin")).resolves.toEqual({
        installUrl: "https://example.com/install",
        inspection: { status: "error", message: "version probe exploded" },
      });
    } finally {
      manager.destroy();
    }
  });

  test("returns null for a provider without an installation contract", async () => {
    const manager = managerWith({ plugin: pluginProvider(undefined) });
    try {
      await expect(manager.installations.inspect("installation-plugin")).resolves.toBeNull();
      await expect(manager.installations.inspect("not-a-provider")).rejects.toThrow(
        "Provider not-a-provider is not configured",
      );
    } finally {
      manager.destroy();
    }
  });

  test("availability and discovery never wait on inspect", async () => {
    let inspectCalls = 0;
    const manager = managerWith({
      plugin: pluginProvider({
        inspect() {
          inspectCalls += 1;
          return new Promise(() => {});
        },
      }),
    });
    try {
      void manager.installations.inspect("installation-plugin");
      const entry = await manager.getProvider({ provider: "installation-plugin", wait: true });
      expect(entry.status).toBe("ready");
      expect(inspectCalls).toBe(1);
    } finally {
      manager.destroy();
    }
  });

  test.each([
    {
      name: "plugin",
      manager: () =>
        managerWith({
          plugin: pluginProvider({
            async checkForUpdates({ launch }) {
              if (!launch?.resolved) throw new Error("Unexpected launch");
              return { status: "available", versions: OPAQUE_VERSIONS, message: OPAQUE_MESSAGE };
            },
          }),
        }),
      provider: "installation-plugin",
    },
    {
      name: "built-in",
      manager: () =>
        managerWith({
          codex: builtinClient({
            async checkForUpdates() {
              return { status: "available", versions: OPAQUE_VERSIONS, message: OPAQUE_MESSAGE };
            },
          }),
        }),
      provider: "codex",
    },
  ])("returns a $name provider's available versions unchanged", async ({ manager, provider }) => {
    const providers = manager();
    try {
      await expect(providers.installations.checkForUpdates(provider)).resolves.toEqual({
        status: "available",
        versions: OPAQUE_VERSIONS,
        message: OPAQUE_MESSAGE,
      });
    } finally {
      providers.destroy();
    }
  });

  test.each([
    {
      name: "returns unknown",
      checkForUpdates: async () => ({ status: "unknown" as const, message: "Offline" }),
      expected: { status: "unknown", message: "Offline" },
    },
    {
      name: "throws",
      checkForUpdates: async (): Promise<never> => {
        throw new Error("release feed exploded");
      },
      expected: { status: "error", message: "release feed exploded" },
    },
    {
      name: "breaks the contract",
      checkForUpdates: async () => ({ status: "up_to_date" }) as never,
      expected: { status: "error", message: expect.stringContaining("status") },
    },
  ])("reports an inconclusive check when the provider $name", async (input) => {
    const manager = managerWith({
      plugin: pluginProvider({ checkForUpdates: input.checkForUpdates }),
    });
    try {
      await expect(manager.installations.checkForUpdates("installation-plugin")).resolves.toEqual(
        input.expected,
      );
    } finally {
      manager.destroy();
    }
  });

  test("returns null when the provider cannot check for updates", async () => {
    const manager = managerWith({
      plugin: pluginProvider({ installUrl: "https://example.com/install" }),
    });
    try {
      await expect(
        manager.installations.checkForUpdates("installation-plugin"),
      ).resolves.toBeNull();
      await expect(manager.installations.checkForUpdates("not-a-provider")).rejects.toThrow(
        "Provider not-a-provider is not configured",
      );
    } finally {
      manager.destroy();
    }
  });

  test("availability, discovery and the installed version never wait on an update check", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const manager = managerWith({
      plugin: pluginProvider({
        async inspect() {
          return { status: "installed", version: "1.0.0" };
        },
        async checkForUpdates() {
          started.resolve();
          await finish.promise;
          return { status: "current" };
        },
      }),
    });
    const updateCheck = manager.installations.checkForUpdates("installation-plugin");
    try {
      await started.promise;
      const entry = await manager.getProvider({ provider: "installation-plugin", wait: true });
      expect(entry.status).toBe("ready");
      await expect(manager.installations.inspect("installation-plugin")).resolves.toEqual({
        inspection: { status: "installed", version: "1.0.0" },
      });
    } finally {
      finish.resolve();
      await updateCheck;
      manager.destroy();
    }
  });
});

describe("ProviderInstallations", () => {
  function counting(
    inspect: NonNullable<AgentClientInstallation["inspect"]>,
    options: { now?: () => number; inspectTimeoutMs?: number } = {},
  ) {
    let calls = 0;
    const client = builtinClient({
      inspect(context) {
        calls += 1;
        return inspect(context);
      },
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: (provider) => (provider === "codex" ? client : null),
      ...options,
    });
    return { installations, calls: () => calls };
  }

  test("shares concurrent reads, caches briefly, and refresh asks again", async () => {
    let time = 0;
    const { installations, calls } = counting(
      async () => ({ status: "installed", version: `v${time}` }),
      { now: () => time },
    );
    const [first, second] = await Promise.all([
      installations.inspect("codex"),
      installations.inspect("codex"),
    ]);
    expect(first).toEqual(second);
    expect(calls()).toBe(1);

    time = 1_000;
    await expect(installations.inspect("codex")).resolves.toEqual({
      inspection: { status: "installed", version: "v0" },
    });
    expect(calls()).toBe(1);

    await expect(installations.inspect("codex", { refresh: true })).resolves.toEqual({
      inspection: { status: "installed", version: "v1000" },
    });
    expect(calls()).toBe(2);

    time = 1_000_000;
    await installations.inspect("codex");
    expect(calls()).toBe(3);
  });

  function countingUpdates(
    checkForUpdates: NonNullable<AgentClientInstallation["checkForUpdates"]>,
    options: { now?: () => number; updateCheckTimeoutMs?: number } = {},
  ) {
    let calls = 0;
    const client = builtinClient({
      checkForUpdates(context) {
        calls += 1;
        return checkForUpdates(context);
      },
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: (provider) => (provider === "codex" ? client : null),
      updateCheckCacheMs: 3_600_000,
      inspectCacheMs: 30_000,
      ...options,
    });
    return { installations, calls: () => calls };
  }

  test("shares concurrent update checks, holds an answer for the long cache, and refresh asks again", async () => {
    let time = 0;
    const { installations, calls } = countingUpdates(
      async () => ({ status: "available", versions: [`v${time}`] }),
      { now: () => time },
    );
    const [first, second] = await Promise.all([
      installations.checkForUpdates("codex"),
      installations.checkForUpdates("codex"),
    ]);
    expect(first).toEqual(second);
    expect(calls()).toBe(1);

    time = 3_000_000;
    await expect(installations.checkForUpdates("codex")).resolves.toEqual({
      status: "available",
      versions: ["v0"],
    });
    expect(calls()).toBe(1);

    await expect(installations.checkForUpdates("codex", { refresh: true })).resolves.toEqual({
      status: "available",
      versions: ["v3000000"],
    });
    expect(calls()).toBe(2);

    time = 3_000_000 + 3_600_000;
    await installations.checkForUpdates("codex");
    expect(calls()).toBe(3);
  });

  test("retries an inconclusive update check after the short cache", async () => {
    let time = 0;
    const { installations, calls } = countingUpdates(async () => ({ status: "unknown" }), {
      now: () => time,
    });
    await installations.checkForUpdates("codex");
    time = 29_000;
    await installations.checkForUpdates("codex");
    expect(calls()).toBe(1);
    time = 31_000;
    await installations.checkForUpdates("codex");
    expect(calls()).toBe(2);
  });

  test("an update check asks with the version the inspection reported, inspecting once", async () => {
    let inspections = 0;
    const versions: (string | undefined)[] = [];
    const client = builtinClient({
      async inspect() {
        inspections += 1;
        return { status: "installed", version: OPAQUE_VERSION };
      },
      async checkForUpdates({ installedVersion }) {
        versions.push(installedVersion);
        return { status: "current" };
      },
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: () => client,
    });
    // The app sends both together; the check joins the inspection instead of starting another.
    await expect(
      Promise.all([installations.inspect("codex"), installations.checkForUpdates("codex")]),
    ).resolves.toEqual([
      { inspection: { status: "installed", version: OPAQUE_VERSION } },
      { status: "current" },
    ]);
    expect(inspections).toBe(1);
    expect(versions).toEqual([OPAQUE_VERSION]);

    await Promise.all([
      installations.inspect("codex", { refresh: true }),
      installations.checkForUpdates("codex", { refresh: true }),
    ]);
    expect(inspections).toBe(2);
    expect(versions).toEqual([OPAQUE_VERSION, OPAQUE_VERSION]);
  });

  test("asks for updates again once the installed version changes", async () => {
    let time = 0;
    let installed = "1.0.0";
    let checks = 0;
    const client = builtinClient({
      async inspect() {
        return { status: "installed", version: installed };
      },
      async checkForUpdates({ installedVersion }) {
        checks += 1;
        return installedVersion === "1.0.0"
          ? { status: "available", versions: ["2.0.0"] }
          : { status: "current" };
      },
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: () => client,
      inspectCacheMs: 30_000,
      updateCheckCacheMs: 3_600_000,
      now: () => time,
    });
    const check = () => installations.checkForUpdates("codex");
    await expect(check()).resolves.toEqual({ status: "available", versions: ["2.0.0"] });

    // The CLI updated itself outside Paseo; the cached inspection still reports 1.0.0.
    installed = "2.0.0";
    time = 29_000;
    await expect(check()).resolves.toEqual({ status: "available", versions: ["2.0.0"] });
    expect(checks).toBe(1);

    // Once the inspection is read again, the check answers for the new version.
    time = 31_000;
    await expect(check()).resolves.toEqual({ status: "current" });
    expect(checks).toBe(2);

    // Two clients reopening together after another change share one new check.
    installed = "3.0.0";
    time = 93_000;
    await Promise.all([check(), check()]);
    expect(checks).toBe(3);

    // The same version again keeps the long-cached answer.
    time = 124_000;
    await check();
    expect(checks).toBe(3);
  });

  test("an update check reports a missing or unreadable installation without asking", async () => {
    let installed = false;
    let checks = 0;
    const client = builtinClient({
      async inspect() {
        if (installed) throw new Error(OPAQUE_MESSAGE);
        return { status: "not_installed" };
      },
      async checkForUpdates() {
        checks += 1;
        return { status: "current" };
      },
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: () => client,
    });
    await expect(installations.checkForUpdates("codex")).resolves.toEqual({
      status: "unknown",
      message: "Not installed",
    });
    installed = true;
    await expect(installations.checkForUpdates("codex", { refresh: true })).resolves.toEqual({
      status: "error",
      message: OPAQUE_MESSAGE,
    });
    expect(checks).toBe(0);
  });

  test("a provider without inspect is asked with no installed version", async () => {
    const versions: (string | undefined)[] = [];
    const { installations } = countingUpdates(async ({ installedVersion }) => {
      versions.push(installedVersion);
      return { status: "current" };
    });
    await installations.checkForUpdates("codex");
    expect(versions).toEqual([undefined]);
  });

  test("aborts a slow update check and reports it as an error", async () => {
    let aborted = false;
    function waitForAbort(signal: AbortSignal) {
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    }
    const { installations } = countingUpdates(({ signal }) => waitForAbort(signal), {
      updateCheckTimeoutMs: 10,
    });
    await expect(installations.checkForUpdates("codex")).resolves.toEqual({
      status: "error",
      message: "Timed out after 10ms",
    });
    expect(aborted).toBe(true);
  });

  test("aborts a slow inspect and reports it as an error", async () => {
    let aborted = false;
    function waitForAbort(signal: AbortSignal) {
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    }
    const { installations } = counting(({ signal }) => waitForAbort(signal), {
      inspectTimeoutMs: 10,
    });
    await expect(installations.inspect("codex")).resolves.toEqual({
      inspection: { status: "error", message: "Timed out after 10ms" },
    });
    expect(aborted).toBe(true);
  });
});

const fakeCheckPhase = "Verifying the Claude Code installation.\n";
const fakeUpdatePhase = "Running the verified native updater.\n";
const fakeVerifyPhase = "Verifying the version selected by the original Claude Code command.\n";
const automatic = async () => ({ kind: "automatic" as const });
const getFakeActivityKeys = async () => ["file:mock-installation"];

describe("provider updates", () => {
  function updating(
    update: NonNullable<AgentClientInstallation["update"]>,
    options: {
      inspect?: AgentClientInstallation["inspect"];
      refreshProvider?: (provider: string) => Promise<void>;
      updateOutputLimit?: number;
    } = {},
  ) {
    let calls = 0;
    const invoked = Promise.withResolvers<void>();
    const client = builtinClient({
      updateUrl: "https://example.com/update",
      inspect: options.inspect,
      getMaintenance: automatic,
      getActivityKeys: getFakeActivityKeys,
      update(context) {
        context.assertCurrent?.();
        calls += 1;
        invoked.resolve();
        return update(context);
      },
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: (provider) => (provider === "codex" ? client : null),
      refreshProvider: options.refreshProvider,
      updateOutputLimit: options.updateOutputLimit,
    });
    const events: ProviderUpdateEvent[] = [];
    const progress: ProviderInstallationUpdateProgress[] = [];
    installations.observeUpdates("codex", (event) => {
      events.push(event);
      if (event.type === "provider.installation.update.progress") progress.push(event.payload);
    });
    return { installations, events, progress, invoked: invoked.promise, calls: () => calls };
  }

  function settled(
    installations: ProviderInstallations,
    provider = "codex",
  ): Promise<ProviderInstallationUpdate> {
    return new Promise((resolve) => {
      const stop = installations.observeUpdates(provider, (event) => {
        if (event.type !== "provider.installation.update.progress") return;
        if (event.payload.operation.status === "running") return;
        stop();
        resolve(installations.getUpdate(provider)!);
      });
    });
  }

  async function expectRefreshClearsFailedApproval(
    installations: ProviderInstallations,
    provider: string,
    planId: string,
  ): Promise<void> {
    const completed = settled(installations, provider);
    const rejected = installations.update(provider, { planId: "unknown-approval" });
    await expect(completed).resolves.toMatchObject({ operation: { status: "failed" } });

    const events: ProviderUpdateEvent[] = [];
    const stop = installations.observeUpdates(provider, (event) => events.push(event));
    try {
      await expect(installations.inspect(provider)).resolves.toMatchObject({
        approvedUpdatePlanId: planId,
      });
      expect(installations.getUpdate(provider)?.operation.status).toBe("failed");

      await expect(installations.inspect(provider, { refresh: true })).resolves.toMatchObject({
        approvedUpdatePlanId: planId,
      });
      expect(installations.getUpdate(provider)).toBeNull();
      expect(events).toEqual([
        {
          type: "provider.installation.update.cleared",
          payload: { provider, operationId: rejected.operation.id },
        },
      ]);
    } finally {
      stop();
    }
  }

  // This runs on real Linux as well as in a macOS test worker simulating Linux.
  test.skipIf(typeof process.geteuid !== "function")(
    "disables host approvals on Linux while an ordinary update still waits for agent activity",
    async () => {
      const cwd = await realpath(fileLockFixture.directory);
      const launchPath = path.join(cwd, "cli");
      const updater = path.join(cwd, "updater");
      const marker = path.join(cwd, "updater-started");
      const planId = "linux-approval";
      await writeFile(launchPath, '#!/bin/sh\nprintf probed > "$0.probed"\n', { mode: 0o700 });
      await writeFile(updater, '#!/bin/sh\nprintf started > "$1"\n', { mode: 0o700 });
      await writeFile(
        path.join(cwd, LOCAL_UPDATER_PLANS_FILENAME),
        formatApprovedProviderUpdaterPlansJson([
          {
            planId,
            provider: "pi",
            completion: "foreground",
            launchPath,
            launchIdentity: await localFileIdentity(launchPath),
            updater: {
              command: updater,
              args: [marker],
              identity: await localFileIdentity(updater),
            },
            evidence: [],
          },
        ]),
        { mode: 0o600 },
      );

      const update = vi.fn<NonNullable<AgentClientInstallation["update"]>>(async (context) => {
        context.assertCurrent?.();
        return { status: "succeeded", outcome: "updated" };
      });
      const resolveApprovedUpdateLaunch = vi.fn(async () => launchPath);
      const runtimeClient = Object.assign(createTestAgentClient("pi"), {
        installation: {
          getMaintenance: automatic,
          getActivityKeys: getFakeActivityKeys,
          resolveApprovedUpdateLaunch,
          update,
        },
      });
      const approvalOnly = builtinClient({ resolveApprovedUpdateLaunch });
      const logger = createTestLogger();
      const installations = new ProviderInstallations({
        logger,
        paseoHome: cwd,
        activity: installationActivity,
        resolveClient: (provider) => (provider === "pi" ? runtimeClient : approvalOnly),
        resolveApprovedUpdateLaunch,
      });
      const manager = new AgentManager({ clients: { pi: runtimeClient }, logger });
      const observe = vi.fn();
      const stop = installations.observeUpdates("pi", observe);
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        await expect(installations.inspect("pi")).resolves.toEqual({
          maintenance: { kind: "automatic" },
          canUpdate: true,
        });
        await expect(installations.inspect("approval-only")).resolves.toBeNull();
        expect(() => installations.update("pi", { planId })).toThrow(
          "Host-approved provider updates are unavailable on this host.",
        );
        expect(installations.getUpdate("pi")).toBeNull();
        expect(observe).not.toHaveBeenCalled();
        expect(resolveApprovedUpdateLaunch).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();

        const agent = await manager.createAgent(
          { cwd, provider: "pi", model: "test-model" },
          undefined,
          {},
        );
        try {
          const blocked = settled(installations, "pi");
          installations.update("pi");
          await expect(blocked).resolves.toMatchObject({
            operation: { status: "failed", message: expect.stringContaining("in use") },
          });
          expect(update).not.toHaveBeenCalled();
        } finally {
          await manager.closeAgent(agent.id);
        }

        const child = acquireInstallationProcess({ family: "pi", keys: [] }, () =>
          spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore" }),
        );
        const closed = once(child, "close");
        try {
          const blocked = settled(installations, "pi");
          installations.update("pi");
          await expect(blocked).resolves.toMatchObject({
            operation: { status: "failed", message: expect.stringContaining("in use") },
          });
          expect(update).not.toHaveBeenCalled();
        } finally {
          child.kill();
          await closed;
        }

        const completed = settled(installations, "pi");
        installations.update("pi");
        await expect(completed).resolves.toMatchObject({
          operation: { status: "succeeded", outcome: "updated" },
        });
        expect(update).toHaveBeenCalledOnce();
        expect(acquireProviderAgentFileTicket).not.toHaveBeenCalled();
        expect(acquireProviderUpdateFileLock).not.toHaveBeenCalled();
        expect(acquireApprovedUpdateFileLock).not.toHaveBeenCalled();
        await expect(access(launchPath + ".probed")).rejects.toHaveProperty("code", "ENOENT");
        await expect(access(marker)).rejects.toHaveProperty("code", "ENOENT");
      } finally {
        Object.defineProperty(process, "platform", platform);
        stop();
        await installations.close();
      }
    },
  );

  // The macOS cases use real file locks under the injected temporary account.
  test.skipIf(!supportsHostApprovedProviderUpdates()).each([
    ["approved", "approved", "shared"],
    ["approved", "approved", "different"],
    ["approved", "ordinary", "shared"],
    ["ordinary", "approved", "shared"],
    ["approved", "ordinary", "different"],
    ["ordinary", "approved", "different"],
  ] as const)(
    "locks %s then %s on %s roots across different Paseo homes",
    async (first, second, roots) => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-cross-instance-")));
      const release = path.join(root, "release");
      const instances: ProviderInstallations[] = [];
      const openOtherAgent = () =>
        installationActivity.acquireAgent({ family: "other", keys: ["path:unrelated"] });
      const prepare = async (name: string, kind: "approved" | "ordinary") => {
        const paseoHome = path.join(root, `home-${name}`);
        const installRoot = path.join(root, roots === "shared" ? "install" : `install-${name}`);
        const launch = path.join(installRoot, `cli-${name}`);
        const updater = path.join(installRoot, `updater-${name}`);
        const marker = path.join(root, `started-${name}`);
        const args = [marker, release];
        await mkdir(paseoHome, { mode: 0o700 });
        await mkdir(installRoot, { recursive: true });
        await Promise.all([
          writeFile(launch, "#!/bin/sh\n", { mode: 0o700 }),
          writeFile(
            updater,
            '#!/bin/sh\nprintf started > "$1"\nwhile [ ! -f "$2" ]; do /bin/sleep 0.05; done\n',
            { mode: 0o700 },
          ),
        ]);
        const planId = `approved-${name}`;
        if (kind === "approved") {
          await writeFile(
            path.join(paseoHome, LOCAL_UPDATER_PLANS_FILENAME),
            formatApprovedProviderUpdaterPlansJson([
              {
                planId,
                provider: "codex",
                completion: "foreground",
                launchPath: launch,
                launchIdentity: await localFileIdentity(launch),
                updater: { command: updater, args, identity: await localFileIdentity(updater) },
                evidence: [],
              },
            ]),
            { mode: 0o600 },
          );
        }
        const client = builtinClient({
          getMaintenance: automatic,
          getActivityKeys: async () => [`root:${installRoot}`],
          update: (context) => runUpdateCommand({ command: updater, args, env: {} }, context),
        });
        const installations = new ProviderInstallations({
          logger: createTestLogger(),
          activity: new InstallationActivity(),
          paseoHome,
          resolveClient: () => client,
          resolveApprovedUpdateLaunch: async () => launch,
        });
        instances.push(installations);
        return {
          marker,
          start: () => {
            const completed = settled(installations);
            installations.update("codex", kind === "approved" ? { planId } : undefined);
            return completed;
          },
        };
      };
      try {
        const leader = await prepare("first", first);
        const follower = await prepare("second", second);
        if (first === "approved") {
          const closeAgent = openOtherAgent();
          try {
            await expect(leader.start()).resolves.toMatchObject({
              operation: {
                status: "failed",
                message: expect.stringContaining(
                  "Paseo agent activity is recorded for this account",
                ),
              },
            });
            await expect(access(leader.marker)).rejects.toHaveProperty("code", "ENOENT");
          } finally {
            closeAgent();
          }
        }
        const completed = leader.start();
        await vi.waitFor(
          async () => expect(await readFile(leader.marker, "utf8")).toBe("started"),
          { timeout: 10_000 },
        );
        if (first === "approved") {
          expect(openOtherAgent).toThrow("An approved provider update is in progress");
        } else {
          openOtherAgent()();
        }
        await expect(follower.start()).resolves.toMatchObject({
          operation: {
            status: "failed",
            message: "Provider updates are locked for this account. Check for an active updater.",
          },
        });
        await expect(access(follower.marker)).rejects.toHaveProperty("code", "ENOENT");
        await writeFile(release, "");
        await expect(completed).resolves.toMatchObject({ operation: { status: "succeeded" } });
        openOtherAgent()();
        await expect(follower.start()).resolves.toMatchObject({
          operation: { status: "succeeded" },
        });
        await expect(readFile(follower.marker, "utf8")).resolves.toBe("started");
      } finally {
        await writeFile(release, "");
        await Promise.all(instances.map((instance) => instance.close()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!supportsHostApprovedProviderUpdates())(
    "offers Generic ACP only when its direct executable has a valid host approval",
    async () => {
      const root = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-generic-acp-approval-")),
      );
      const provider = "local-generic-acp";
      const launchPath = path.join(root, "cli");
      const updater = path.join(root, "updater");
      const updated = path.join(root, "updated");
      const manager = new ProviderSnapshotManager({
        logger: createTestLogger(),
        paseoHome: root,
        providerOverrides: {
          [provider]: {
            extends: "acp",
            label: "Generic ACP test",
            command: [launchPath],
          },
        },
      });
      try {
        await writeFile(launchPath, '#!/bin/sh\nprintf probed > "$0.probed"\n', { mode: 0o700 });
        await writeFile(updater, '#!/bin/sh\nprintf updated > "$1"\n', { mode: 0o700 });
        const { installations } = manager;
        const refresh = vi.spyOn(manager, "refreshSettingsSnapshot");
        await expect(installations.inspect(provider)).resolves.toBeNull();
        expect(() => installations.update(provider)).toThrow("using its original installer");

        const planId = "acp-approved";
        await writeFile(
          path.join(root, LOCAL_UPDATER_PLANS_FILENAME),
          formatApprovedProviderUpdaterPlansJson([
            {
              planId,
              provider,
              completion: "foreground",
              launchPath,
              launchIdentity: await localFileIdentity(launchPath),
              updater: {
                command: updater,
                args: [updated],
                identity: await localFileIdentity(updater),
              },
              evidence: [],
            },
          ]),
          { mode: 0o600 },
        );
        await expect(installations.inspect(provider, { refresh: true })).resolves.toEqual({
          approvedUpdatePlanId: planId,
        });
        expect(() => installations.update(provider)).toThrow("using its original installer");
        await expectRefreshClearsFailedApproval(installations, provider, planId);
        const completed = settled(installations, provider);
        installations.update(provider, { planId });
        await expect(completed).resolves.toMatchObject({
          operation: { status: "succeeded", outcome: "unverified" },
        });
        await expect(readFile(updated, "utf8")).resolves.toBe("updated");
        await expect(access(launchPath + ".probed")).rejects.toHaveProperty("code", "ENOENT");
        expect(refresh).not.toHaveBeenCalled();
      } finally {
        await manager.shutdown();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!supportsHostApprovedProviderUpdates())(
    "executes the exact local approval and refuses changes to the launch or approved arguments",
    async () => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-host-updater-")));
      try {
        const command = path.join(root, "updater");
        const updaterTarget = path.join(root, "updater-target");
        const launchPath = path.join(root, "cli");
        const launchTarget = path.join(root, "cli-target");
        const log = path.join(root, "called");
        await writeFile(
          updaterTarget,
          '#!/bin/sh\nprintf "%s" "$1" > "$2"\nprintf "%s" "$0" > "$2.path"\n' +
            'printf "downloading %s\\n" "$1"\n' +
            'printf "permission denied %s\\n" "arbitrary-stderr-value" >&2\n' +
            'exit "$3"\n',
          { mode: 0o755 },
        );
        await symlink(updaterTarget, command);
        await writeFile(launchTarget, '#!/bin/sh\nprintf checked > "$0.probed"\n', { mode: 0o755 });
        await symlink(launchTarget, launchPath);
        const planId = "test-host-plan";
        const writePlan = async (arg: string, exitCode = "0") =>
          writeFile(
            path.join(root, LOCAL_UPDATER_PLANS_FILENAME),
            formatApprovedProviderUpdaterPlansJson([
              {
                planId,
                provider: "codex",
                completion: "foreground",
                launchPath,
                launchIdentity: await localFileIdentity(launchPath),
                updater: {
                  command,
                  args: [arg, log, exitCode],
                  identity: await localFileIdentity(command),
                },
                evidence: [],
              },
            ]),
            { mode: 0o600 },
          );
        await writePlan("approved argument");
        const activity = new InstallationActivity();
        const nativeUpdate = vi.fn(async () => ({ status: "succeeded" as const }));
        const refreshProvider = vi.fn(async () => {});
        const getMaintenance = vi.fn(async () => ({
          kind: nativeAvailable ? ("automatic" as const) : ("manual" as const),
        }));
        const resolveApprovedUpdateLaunch = vi.fn(async () => null);
        let nativeAvailable = false;
        let discoveryDeferred = false;
        let configurationVersion = 0;
        const client = builtinClient({
          getMaintenance,
          getActivityKeys: async () => ["file:verified-native"],
          update: nativeUpdate,
          resolveApprovedUpdateLaunch,
        });
        let selectedLaunch = launchPath;
        let rewrite: Promise<void> | undefined;
        const logs: string[] = [];
        const installations = new ProviderInstallations({
          logger: pino({ level: "trace" }, { write: (line) => logs.push(line) }),
          resolveClient: () => client,
          paseoHome: root,
          activity,
          refreshProvider,
          isDiscoveryDeferred: () => discoveryDeferred,
          configurationVersion: () => configurationVersion,
          resolveApprovedUpdateLaunch: async (_provider, signal) => {
            await rewrite;
            signal.throwIfAborted();
            return findInstallationLaunchPath(selectedLaunch, { cwd: root });
          },
        });
        await expect(installations.inspect("codex")).resolves.toEqual({
          maintenance: { kind: "manual" },
          approvedUpdatePlanId: planId,
        });
        const ordinary = settled(installations);
        installations.update("codex");
        await expect(ordinary).resolves.toMatchObject({ operation: { status: "failed" } });

        nativeAvailable = true;
        const unknown = settled(installations);
        installations.update("codex", { planId: "unknown-plan" });
        await expect(unknown).resolves.toMatchObject({
          operation: {
            status: "failed",
            message: "Paseo could not verify a local update plan for this installation.",
          },
        });
        nativeAvailable = false;
        await expect(access(log)).rejects.toHaveProperty("code", "ENOENT");

        const release = activity.acquireAgent({
          family: "other-provider",
          keys: [`path:${launchPath}`],
        });
        const busy = settled(installations);
        installations.update("codex", { planId });
        await expect(busy).resolves.toMatchObject({
          operation: {
            status: "failed",
            message:
              "This installation is in use by a Paseo agent. Close its runtime before updating.",
          },
        });
        release();
        await expect(access(log)).rejects.toHaveProperty("code", "ENOENT");

        const onFirstOutput = (change: () => void) =>
          installations.observeUpdates("codex", (event) => {
            if (
              event.type === "provider.installation.update.progress" &&
              event.payload.operation.status === "running" &&
              event.payload.output.length > 0
            ) {
              change();
            }
          });
        const stop = onFirstOutput(() => {
          selectedLaunch = path.join(root, "other-cli");
        });
        const rejected = settled(installations);
        const update = installations.update("codex", { planId });
        expect(installations.update("codex", { planId }).operation.id).toBe(update.operation.id);
        expect(() => installations.update("codex", { planId: "different-plan" })).toThrow(
          "An update is already in progress",
        );
        expect(() => installations.update("codex")).toThrow("An update is already in progress");
        await expect(rejected).resolves.toMatchObject({
          operation: {
            status: "failed",
            message: "Paseo could not verify a local update plan for this installation.",
          },
        });
        stop();
        await expect(access(log)).rejects.toHaveProperty("code", "ENOENT");

        selectedLaunch = launchPath;
        const stopRewrite = onFirstOutput(() => {
          rewrite = writePlan("replaced argument");
        });
        const changedPlan = settled(installations);
        installations.update("codex", { planId });
        await expect(changedPlan).resolves.toMatchObject({
          operation: {
            status: "failed",
            message: "Paseo could not verify a local update plan for this installation.",
          },
        });
        stopRewrite();
        await expect(access(log)).rejects.toHaveProperty("code", "ENOENT");

        await writePlan("approved argument");
        discoveryDeferred = true;
        getMaintenance.mockClear();
        resolveApprovedUpdateLaunch.mockClear();
        await expect(installations.inspect("codex")).resolves.toEqual({
          approvedUpdatePlanId: planId,
        });
        await expect(installations.checkForUpdates("codex")).resolves.toBeNull();
        expect(() => installations.update("codex")).toThrow("using its original installer");
        expect(getMaintenance).not.toHaveBeenCalled();
        expect(resolveApprovedUpdateLaunch).not.toHaveBeenCalled();

        const stopConfigurationChange = onFirstOutput(() => {
          configurationVersion += 1;
        });
        const stale = settled(installations);
        installations.update("codex", { planId });
        await expect(stale).resolves.toMatchObject({
          operation: {
            status: "failed",
            message: "Provider configuration changed. Inspect the installation and retry.",
          },
        });
        stopConfigurationChange();
        await expect(access(log)).rejects.toHaveProperty("code", "ENOENT");

        const emitted: ProviderUpdateEvent[] = [];
        const stopObserving = installations.observeUpdates("codex", (event) => emitted.push(event));
        const completed = settled(installations);
        installations.update("codex", { planId });
        await expect(completed).resolves.toMatchObject({
          operation: { status: "succeeded", outcome: "unverified" },
          output: [{ type: "message", text: fakeUpdatePhase }],
        });
        await expect(readFile(log, "utf8")).resolves.toBe("approved argument");
        await expect(readFile(log + ".path", "utf8")).resolves.toBe(updaterTarget);

        await writePlan("approved argument", "41");
        const failed = settled(installations);
        installations.update("codex", { planId });
        await expect(failed).resolves.toMatchObject({
          operation: { status: "failed", message: "The updater failed." },
          output: [{ type: "message", text: fakeUpdatePhase }],
        });
        stopObserving();
        expect(
          emitted.flatMap((event) =>
            event.type === "provider.installation.update.progress" ? event.payload.output : [],
          ),
        ).toEqual([
          { type: "message", text: fakeUpdatePhase },
          { type: "message", text: fakeUpdatePhase },
        ]);
        const observable = JSON.stringify([emitted, installations.getUpdate("codex"), logs]);
        expect(observable).not.toContain("approved argument");
        expect(observable).not.toContain("arbitrary-stderr-value");
        await expect(access(launchPath + ".probed")).rejects.toHaveProperty("code", "ENOENT");
        expect(refreshProvider).not.toHaveBeenCalled();
        expect(resolveApprovedUpdateLaunch).not.toHaveBeenCalled();
        expect(nativeUpdate).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!supportsHostApprovedProviderUpdates())(
    "uses a host approval after the custom CLI form saves a deferred launcher",
    async () => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-form-approval-")));
      const logger = createTestLogger();
      const manager = new ProviderSnapshotManager({ logger, paseoHome: root });
      const store = new DaemonConfigStore(root, {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      });
      const detach = attachMutableProviderConfigOwner({
        store,
        providerSnapshotManager: manager,
        updateProviderRegistry: () => undefined,
      });
      try {
        const launchPath = path.join(root, "custom-codex");
        const updater = path.join(root, "updater");
        const updated = path.join(root, "updated");
        await copyFile(process.execPath, launchPath);
        await chmod(launchPath, 0o700);
        await writeFile(updater, '#!/bin/sh\nprintf updated > "$1"\n', { mode: 0o700 });
        await writeFile(path.join(root, "config.json"), JSON.stringify({ version: 1 }));
        const planId = "form-approved";
        await writeFile(
          path.join(root, LOCAL_UPDATER_PLANS_FILENAME),
          formatApprovedProviderUpdaterPlansJson([
            {
              planId,
              provider: "codex",
              completion: "foreground",
              launchPath,
              launchIdentity: await localFileIdentity(launchPath),
              updater: {
                command: updater,
                args: [updated],
                identity: await localFileIdentity(updater),
              },
              evidence: [],
            },
          ]),
          { mode: 0o600 },
        );
        await expect(
          runCustomProviderCliOperation(
            "save",
            {
              mode: "edit",
              providerId: "codex",
              command: [launchPath],
              env: { PATH: "/usr/bin:/bin" },
            },
            {
              configStore: store,
              isRegisteredProvider: (id) => manager.hasProvider(id),
              isPluginProvider: (id) => manager.isPluginProvider(id),
            },
          ),
        ).resolves.toEqual({ status: "ok" });

        const { installations } = manager;
        expect(manager.isProviderDiscoveryDeferred("codex")).toBe(true);
        await expect(installations.inspect("codex", { refresh: true })).resolves.toMatchObject({
          approvedUpdatePlanId: planId,
        });
        await expect(installations.checkForUpdates("codex", { refresh: true })).resolves.toBeNull();
        await expectRefreshClearsFailedApproval(installations, "codex", planId);
        const completed = settled(installations);
        installations.update("codex", { planId });
        await expect(completed).resolves.toMatchObject({
          operation: { status: "succeeded", outcome: "unverified" },
        });
        await expect(readFile(updated, "utf8")).resolves.toBe("updated");
        expect(manager.isProviderDiscoveryDeferred("codex")).toBe(true);
        await expect(installations.checkForUpdates("codex")).resolves.toBeNull();
      } finally {
        detach();
        await manager.shutdown();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!supportsHostApprovedProviderUpdates()).each([
    ["codex", "claude"],
    ["claude", "codex"],
  ] as const)(
    "serializes %s then %s across different launchers sharing one installation root",
    async (first, second) => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-shared-update-root-")));
      const release = path.join(root, "release");
      const plans = path.join(root, LOCAL_UPDATER_PLANS_FILENAME);
      const approvedLaunch = path.join(root, "approved-cli");
      const managedLaunch = path.join(root, "managed-cli");
      const approvedUpdater = path.join(root, "approved-updater");
      const managedUpdater = path.join(root, "managed-updater");
      const approvedMarker = path.join(root, "approved-started");
      const managedMarker = path.join(root, "managed-started");
      const planId = "approved-shared-root";
      const updater =
        '#!/bin/sh\nprintf started > "$1"\nwhile [ ! -f "$2" ]; do /bin/sleep 0.05; done\n';
      const managed = {
        ...builtinClient({
          getMaintenance: automatic,
          getActivityKeys: async () => [`root:${root}`, `path:${managedLaunch}`],
          update: (context) =>
            runUpdateCommand(
              { command: managedUpdater, args: [managedMarker, release], env: {} },
              context,
            ),
        }),
        provider: "claude",
      } satisfies AgentClient;
      const approved = builtinClient({ resolveApprovedUpdateLaunch: async () => approvedLaunch });
      const installations = new ProviderInstallations({
        logger: createTestLogger(),
        paseoHome: root,
        resolveClient: (provider) => (provider === "codex" ? approved : managed),
        resolveApprovedUpdateLaunch: async (provider) =>
          provider === "codex" ? approvedLaunch : null,
      });
      const start = (provider: "codex" | "claude") =>
        provider === "codex"
          ? installations.update(provider, { planId })
          : installations.update(provider);
      const startedOrSettled = (provider: string) =>
        new Promise<ProviderInstallationUpdateProgress>((resolve) => {
          const stop = installations.observeUpdates(provider, (event) => {
            if (event.type !== "provider.installation.update.progress") return;
            if (event.payload.operation.status === "running" && event.payload.output.length === 0)
              return;
            stop();
            resolve(event.payload);
          });
        });
      try {
        await Promise.all([
          writeFile(approvedLaunch, "#!/bin/sh\n", { mode: 0o700 }),
          writeFile(managedLaunch, "#!/bin/sh\n", { mode: 0o700 }),
          writeFile(approvedUpdater, updater, { mode: 0o700 }),
          writeFile(managedUpdater, updater, { mode: 0o700 }),
        ]);
        await writeFile(
          plans,
          formatApprovedProviderUpdaterPlansJson([
            {
              planId,
              provider: "codex",
              completion: "foreground",
              launchPath: approvedLaunch,
              launchIdentity: await localFileIdentity(approvedLaunch),
              updater: {
                command: approvedUpdater,
                args: [approvedMarker, release],
                identity: await localFileIdentity(approvedUpdater),
              },
              evidence: [],
            },
          ]),
          { mode: 0o600 },
        );
        const firstReady = startedOrSettled(first);
        const firstDone = settled(installations, first);
        start(first);
        await expect(firstReady).resolves.toMatchObject({ operation: { status: "running" } });

        const secondReady = startedOrSettled(second);
        start(second);
        await expect(secondReady).resolves.toMatchObject({
          operation: {
            status: "failed",
            message: "An update is already in progress for this installation.",
          },
        });
        const secondMarker = second === "codex" ? approvedMarker : managedMarker;
        await expect(access(secondMarker)).rejects.toHaveProperty("code", "ENOENT");
        await writeFile(release, "");
        await expect(firstDone).resolves.toMatchObject({ operation: { status: "succeeded" } });

        const retry = settled(installations, second);
        start(second);
        await expect(retry).resolves.toMatchObject({ operation: { status: "succeeded" } });
        await expect(readFile(secondMarker, "utf8")).resolves.toBe("started");
      } finally {
        await writeFile(release, "");
        await installations.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "keeps an unpinned npm update manual and honors the verified native updater's lock",
    async () => {
      const root = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-approved-installation-")),
      );
      try {
        const bin = path.join(root, "bin");
        const modules = path.join(root, "lib/node_modules");
        const npm = path.join(modules, "npm");
        const cli = path.join(modules, "test-provider");
        const manifest = path.join(cli, "package.json");
        const launchPath = path.join(bin, "test-provider");
        const log = path.join(root, "called");
        const metadata = (version: string) =>
          JSON.stringify({
            name: "test-provider",
            bin: { "test-provider": "cli" },
            version,
            _from: "test-provider",
            _resolved: `https://registry.npmjs.org/test-provider/-/test-provider-${version}.tgz`,
            _integrity: "sha512-YQ==",
          });
        await Promise.all(
          [bin, path.join(npm, "bin"), cli].map((dir) => mkdir(dir, { recursive: true })),
        );
        await Promise.all([
          writeFile(manifest, metadata("1.1.0")),
          writeFile(path.join(cli, "cli"), "#!/bin/sh\n", { mode: 0o755 }),
          writeFile(
            path.join(npm, "package.json"),
            JSON.stringify({ name: "npm", version: "6.0.0", bin: { npm: "bin/npm-cli.js" } }),
          ),
          writeFile(
            path.join(npm, "bin/npm-cli.js"),
            `#!/bin/sh\nprintf '%s' called > '${log}'\nprintf '%s' '${metadata("1.2.0")}' > '${manifest}'\n`,
            { mode: 0o755 },
          ),
        ]);
        await Promise.all([
          symlink(path.join(cli, "cli"), launchPath),
          symlink(path.join(npm, "bin/npm-cli.js"), path.join(bin, "npm")),
        ]);
        vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
        const activity = new InstallationActivity();
        let nativeAvailable = false;
        const nativeUpdate = vi.fn<NonNullable<AgentClientInstallation["update"]>>(
          async (context) => {
            context.assertCurrent?.();
            return { status: "succeeded", outcome: "unverified" };
          },
        );
        const client = builtinClient({
          getMaintenance: async () => ({ kind: nativeAvailable ? "automatic" : "manual" }),
          getActivityKeys: async () => [`root:${root}`],
          update: nativeUpdate,
          inspect: async () => ({ status: "installed", version: "1.1.0" }),
          resolveApprovedUpdateLaunch: async () => launchPath,
        });
        const installations = new ProviderInstallations({
          logger: createTestLogger(),
          resolveClient: () => client,
          activity,
        });
        await expect(installations.inspect("codex")).resolves.toEqual({
          inspection: { status: "installed", version: "1.1.0" },
          maintenance: { kind: "manual" },
        });
        expect(() => installations.update("codex", { planId: "unknown" })).toThrow(
          "Paseo could not verify a local update plan",
        );
        const denied = settled(installations);
        installations.update("codex");
        await expect(denied).resolves.toMatchObject({ operation: { status: "failed" } });
        await expect(access(log)).rejects.toHaveProperty("code", "ENOENT");
        expect(nativeUpdate).not.toHaveBeenCalled();

        nativeAvailable = true;
        const release = activity.acquireAgent({
          family: "second-provider",
          keys: [`root:${root}`],
        });
        const blocked = settled(installations);
        installations.update("codex");
        await expect(blocked).resolves.toMatchObject({
          operation: {
            status: "failed",
            message:
              "This installation is in use by a Paseo agent. Close its runtime before updating.",
          },
        });
        release();
        await expect(access(log)).rejects.toHaveProperty("code", "ENOENT");

        expect(nativeUpdate).not.toHaveBeenCalled();

        const nativeCompleted = settled(installations);
        installations.update("codex");
        await expect(nativeCompleted).resolves.toMatchObject({
          operation: { status: "succeeded", outcome: "unverified" },
        });
        expect(nativeUpdate).toHaveBeenCalledTimes(1);
        await expect(access(log)).rejects.toHaveProperty("code", "ENOENT");
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("enforces fresh external maintenance at update time and retains the refusal", async () => {
    let external = false;
    const update = vi.fn(async () => ({ status: "succeeded" as const }));
    const client = builtinClient({
      update,
      getActivityKeys: getFakeActivityKeys,
      async getMaintenance() {
        return external
          ? { kind: "external", message: "Update the connected server on its host." }
          : { kind: "automatic" };
      },
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: () => client,
    });
    await expect(installations.inspect("codex")).resolves.toMatchObject({
      canUpdate: true,
      maintenance: { kind: "automatic" },
    });
    external = true;
    const done = settled(installations);
    installations.update("codex");
    await expect(done).resolves.toMatchObject({
      operation: {
        status: "failed",
        message: "Update this installation on the host that manages it.",
      },
    });
    expect(update).not.toHaveBeenCalled();
    const view = await installations.inspect("codex");
    expect(view).toEqual({
      maintenance: { kind: "external", message: "Update the connected server on its host." },
    });
    expect(installations.getUpdate("codex")?.operation.status).toBe("failed");
    await installations.checkForUpdates("codex", { refresh: true });
    expect(installations.getUpdate("codex")?.operation.status).toBe("failed");
    await installations.inspect("codex", { refresh: true });
    expect(installations.getUpdate("codex")).toBeNull();
  });

  test.each([
    { name: "no maintenance", getActivityKeys: getFakeActivityKeys },
    { name: "no keys", getMaintenance: automatic },
    { name: "empty keys", getMaintenance: automatic, getActivityKeys: async () => [] },
    {
      name: "opaque launch",
      getMaintenance: automatic,
      getActivityKeys: async () => ["opaque", "file:mock"],
    },
  ])("rejects an unproven updater with $name", async (proof) => {
    const update = vi.fn(async () => ({ status: "succeeded" as const }));
    const client = builtinClient({ ...proof, update });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: () => client,
    });
    await expect(installations.inspect("codex")).resolves.not.toHaveProperty("canUpdate");
    const done = settled(installations);
    installations.update("codex");
    await expect(done).resolves.toMatchObject({
      operation: {
        status: "failed",
        message: "Paseo could not verify a local update plan for this installation.",
      },
    });
    expect(update).not.toHaveBeenCalled();
  });

  test.each([
    { change: "launch", when: "prepared", outcome: "updated" },
    { change: "launch", when: "before spawn", outcome: "failed" },
    { change: "launch", when: "after spawn", outcome: "unverified" },
    { change: "display", when: "before spawn", outcome: "updated" },
    { change: "display", when: "after spawn", outcome: "updated" },
  ] as const)(
    "checks the published provider config for a $change edit $when",
    async ({ change, when, outcome }) => {
      const preflight = Promise.withResolvers<void>();
      const allowSpawn = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const allowResult = Promise.withResolvers<void>();
      const launch = vi.fn(() => started.resolve());
      const client = builtinClient({
        getMaintenance: automatic,
        getActivityKeys: getFakeActivityKeys,
        update: async ({ assertCurrent }) => {
          preflight.resolve();
          await allowSpawn.promise;
          assertCurrent?.();
          launch();
          await allowResult.promise;
          return { status: "succeeded", outcome: "updated" };
        },
      });
      // The snapshot keeps this injected client even when it publishes a different definition.
      const manager = managerWith({ codex: client });
      const { installations } = manager;
      try {
        const done = settled(installations);
        installations.update("codex");
        await preflight.promise;
        const next = manager.prepareMutableProviderConfig({
          codex:
            change === "display"
              ? { label: "New display name", description: "New description" }
              : { command: ["new-codex"] },
        });

        if (when === "before spawn") next.commit();
        allowSpawn.resolve();
        if (when === "after spawn") {
          await started.promise;
          next.commit();
        }
        allowResult.resolve();
        const result = await done;
        if (outcome === "failed") {
          expect(launch).not.toHaveBeenCalled();
          expect(result.operation).toMatchObject({
            status: "failed",
            message: "Provider configuration changed. Inspect the installation and retry.",
          });
        } else {
          expect(launch).toHaveBeenCalledTimes(1);
          expect(result.operation).toMatchObject({
            status: "succeeded",
            outcome,
          });
        }
      } finally {
        allowSpawn.resolve();
        allowResult.resolve();
        await installations.close();
        manager.destroy();
      }
    },
  );

  test("refuses an update against an active alias and publishes the verified outcome after release", async () => {
    const activity = new InstallationActivity();
    const release = activity.acquireAgent({ family: "alias", keys: ["file:shared"] });
    const update = vi.fn<NonNullable<AgentClientInstallation["update"]>>(async (context) => {
      context.assertCurrent?.();
      return { status: "succeeded", outcome: "updated" };
    });
    const client = builtinClient({
      update,
      getMaintenance: automatic,
      getActivityKeys: async () => ["file:shared"],
    });
    const installations = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: () => client,
      activity,
    });

    const refused = settled(installations);
    installations.update("codex");
    await expect(refused).resolves.toMatchObject({
      operation: { status: "failed", message: expect.stringContaining("in use") },
    });
    expect(update).not.toHaveBeenCalled();

    release();
    const accepted = settled(installations);
    installations.update("codex");
    await expect(accepted).resolves.toMatchObject({
      operation: { status: "succeeded", outcome: "updated" },
    });
  });

  test("keeps an admitted agent opening exclusive with a provider update", async () => {
    const entered = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();
    const fake = createTestAgentClient("pi", {
      beforeCreateSession: async () => {
        entered.resolve();
        await admitted.promise;
      },
    });
    const update = vi.fn<NonNullable<AgentClientInstallation["update"]>>(async (context) => {
      context.assertCurrent?.();
      return { status: "succeeded" };
    });
    const runtimeClient = Object.assign(fake, {
      installation: {
        update,
        getMaintenance: automatic,
        getActivityKeys: async () => ["file:fake-runtime"],
      },
    });
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-update-admission-"));
    const logger = createTestLogger();
    const manager = new AgentManager({ clients: { pi: runtimeClient }, logger });
    const updaterClient = builtinClient(runtimeClient.installation);
    const installations = new ProviderInstallations({
      logger,
      resolveClient: () => updaterClient,
      activity: installationActivity,
    });
    const config = { cwd, provider: "pi", model: "test-model" };
    const creating = manager.createAgent(config, undefined, {});
    try {
      await entered.promise;
      const blocked = settled(installations);
      installations.update("codex");
      await expect(blocked).resolves.toMatchObject({
        operation: { status: "failed", message: expect.stringContaining("in use") },
      });
      expect(update).not.toHaveBeenCalled();
    } finally {
      admitted.resolve();
      try {
        const agent = await creating;
        await manager.closeAgent(agent.id);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }

    const completed = settled(installations);
    installations.update("codex");
    await expect(completed).resolves.toMatchObject({ operation: { status: "succeeded" } });
  });

  test.skipIf(!supportsHostApprovedProviderUpdates())(
    "agent sessions and self-managed children honor the same account approval lock",
    async () => {
      const cwd = fileLockFixture.directory;
      const client = createTestAgentClient("pi");
      const manager = new AgentManager({ clients: { pi: client }, logger: createTestLogger() });
      const config = { cwd, provider: "pi", model: "test-model" };
      const openAgent = () => manager.createAgent(config, undefined, {});
      const spawnChild = vi.fn(() =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore" }),
      );
      const openChild = () =>
        acquireInstallationProcess({ family: "self-managed", keys: [] }, spawnChild);

      const releaseApproval = await acquireApprovedUpdateFileLock();
      try {
        await expect(openAgent()).rejects.toThrow("An approved provider update is in progress");
        expect(openChild).toThrow("An approved provider update is in progress");
        expect(spawnChild).not.toHaveBeenCalled();
      } finally {
        await releaseApproval();
      }

      const agent = await openAgent();
      try {
        await expect(acquireApprovedUpdateFileLock()).rejects.toThrow(
          "Paseo agent activity is recorded for this account",
        );
      } finally {
        await manager.closeAgent(agent.id);
      }

      const child = openChild();
      const closed = once(child, "close");
      try {
        await expect(acquireApprovedUpdateFileLock()).rejects.toThrow(
          "Paseo agent activity is recorded for this account",
        );
      } finally {
        child.kill();
        await closed;
      }

      const retry = await acquireApprovedUpdateFileLock();
      await retry();
    },
  );

  test("streams fixed phases in order and never exposes raw output or callback results", async () => {
    const { installations, progress } = updating(async ({ report }) => {
      report({ type: "message", text: fakeCheckPhase });
      report({ type: "message", text: fakeCheckPhase });
      report({ type: "stdout", text: "credential-".repeat(900) });
      report({ type: "stderr", text: "passphrase" });
      report({ type: "stdout", text: "" });
      report({ type: "message", text: fakeVerifyPhase });
      return { status: "succeeded", message: "secret-result" };
    });
    const done = settled(installations);
    const started = installations.update("codex");
    expect(started.operation.status).toBe("running");

    const output = [
      { type: "message", text: fakeCheckPhase },
      { type: "message", text: fakeVerifyPhase },
    ];
    await expect(done).resolves.toEqual({
      operation: {
        status: "succeeded",
        id: started.operation.id,
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
      },
      output,
      truncated: true,
    });
    expect(progress.map((event) => event.operation.status)).toEqual([
      "running",
      "running",
      "running",
      "succeeded",
    ]);
    expect(progress.flatMap((event) => event.output)).toEqual(output);
  });

  test("reports a controlled failure with the earlier safe output", async () => {
    const { installations } = updating(async ({ report }) => {
      report({ type: "message", text: fakeUpdatePhase });
      report({ type: "stderr", text: "permission issue with secret environment" });
      return { status: "failed", message: "The native updater exited with code 5." };
    });
    const done = settled(installations);
    installations.update("codex");
    await expect(done).resolves.toMatchObject({
      operation: { status: "failed", message: "The native updater exited with code 5." },
      output: [{ type: "message", text: fakeUpdatePhase }],
    });
  });

  test("redacts exception details and retains earlier safe output", async () => {
    const { installations } = updating(async ({ report }) => {
      report({ type: "message", text: fakeUpdatePhase });
      throw new Error("token=secret");
    });
    const done = settled(installations);
    installations.update("codex");
    await expect(done).resolves.toMatchObject({
      operation: { status: "failed", message: "The updater failed." },
      output: [{ type: "message", text: fakeUpdatePhase }],
    });
  });

  test("a refresh drops a failed update and keeps a running one", async () => {
    const finish = Promise.withResolvers<void>();
    let attempt = 0;
    const { installations } = updating(
      async () => {
        attempt += 1;
        if (attempt === 1) return { status: "failed", message: "EACCES" };
        await finish.promise;
        return { status: "succeeded" };
      },
      { inspect: async () => ({ status: "installed", version: "1.0.0" }) },
    );
    const failed = settled(installations);
    installations.update("codex");
    await failed;
    await installations.inspect("codex");
    expect(installations.getUpdate("codex")?.operation.status).toBe("failed");
    await installations.inspect("codex", { refresh: true });
    expect(installations.getUpdate("codex")).toBeNull();

    const running = installations.update("codex");
    await installations.inspect("codex", { refresh: true });
    await installations.checkForUpdates("codex", { refresh: true });
    expect(installations.getUpdate("codex")?.operation.id).toBe(running.operation.id);
    const done = settled(installations);
    finish.resolve();
    await done;
  });

  test("tells observers when a refresh drops a failed update", async () => {
    const { installations, events } = updating(
      async () => ({ status: "failed", message: "EACCES" }),
      {
        inspect: async () => ({ status: "installed", version: "1.0.0" }),
      },
    );
    const failed = settled(installations);
    const started = installations.update("codex");
    await failed;
    events.length = 0;

    await installations.inspect("codex", { refresh: true });
    await installations.inspect("codex", { refresh: true });
    expect(events).toEqual([
      {
        type: "provider.installation.update.cleared",
        payload: { provider: "codex", operationId: started.operation.id },
      },
    ]);
  });

  test("a second request while an update runs joins it instead of starting another", async () => {
    const finish = Promise.withResolvers<void>();
    const { installations, invoked, calls } = updating(async ({ report }) => {
      report({ type: "message", text: fakeUpdatePhase });
      await finish.promise;
      return { status: "succeeded" };
    });
    const first = installations.update("codex");
    const second = installations.update("codex");
    expect(second.operation.id).toBe(first.operation.id);
    await invoked;
    expect(installations.getUpdate("codex")?.output).toEqual([
      { type: "message", text: fakeUpdatePhase },
    ]);
    expect(calls()).toBe(1);

    const done = settled(installations);
    finish.resolve();
    await expect(done).resolves.toMatchObject({ operation: { status: "succeeded" } });
    const thirdDone = settled(installations);
    const third = installations.update("codex");
    expect(third.operation.id).not.toBe(first.operation.id);
    await thirdDone;
    expect(calls()).toBe(2);
  });

  test("after success the next read asks the provider again and discovery refreshes", async () => {
    let version = "1.0.0";
    const refreshed: string[] = [];
    const { installations } = updating(
      async () => {
        version = "2.0.0";
        return { status: "succeeded" };
      },
      {
        inspect: async () => ({ status: "installed", version }),
        refreshProvider: async (provider) => {
          refreshed.push(provider);
        },
      },
    );
    await expect(installations.inspect("codex")).resolves.toMatchObject({
      inspection: { version: "1.0.0" },
    });
    const done = settled(installations);
    installations.update("codex");
    await done;
    await expect(installations.inspect("codex")).resolves.toMatchObject({
      inspection: { version: "2.0.0" },
    });
    expect(refreshed).toEqual(["codex"]);
  });

  test("a failed refresh after success still reports success; a failure keeps the caches", async () => {
    let version = "1.0.0";
    let result: "succeeded" | "failed" = "failed";
    const { installations } = updating(
      async () => {
        version = "2.0.0";
        return result === "succeeded" ? { status: result } : { status: result, message: "no" };
      },
      {
        inspect: async () => ({ status: "installed", version }),
        refreshProvider: async () => {
          throw new Error("discovery failed");
        },
      },
    );
    await installations.inspect("codex");
    let done = settled(installations);
    installations.update("codex");
    await done;
    await expect(installations.inspect("codex")).resolves.toMatchObject({
      inspection: { version: "1.0.0" },
    });

    result = "succeeded";
    done = settled(installations);
    installations.update("codex");
    await expect(done).resolves.toMatchObject({ operation: { status: "succeeded" } });
  });

  test("retains the most recent safe output within the limit and marks the drop", async () => {
    const { installations, progress } = updating(
      async ({ report }) => {
        report({ type: "message", text: fakeCheckPhase });
        report({ type: "message", text: fakeUpdatePhase });
        report({ type: "message", text: fakeVerifyPhase });
        return { status: "succeeded" };
      },
      { updateOutputLimit: fakeVerifyPhase.length },
    );
    const done = settled(installations);
    installations.update("codex");
    const update = await done;
    expect(update.output).toEqual([{ type: "message", text: fakeVerifyPhase }]);
    expect(update.truncated).toBe(true);
    expect(progress.flatMap((event) => event.output).at(-1)).toEqual({
      type: "message",
      text: fakeVerifyPhase,
    });
  });

  test("advertises the update only when the provider declares one", async () => {
    const { installations } = updating(async () => ({ status: "succeeded" }));
    await expect(installations.inspect("codex")).resolves.toEqual({
      updateUrl: "https://example.com/update",
      maintenance: { kind: "automatic" },
      canUpdate: true,
    });
    // The update never depends on a check: this provider has none, and it still updates.
    await expect(installations.checkForUpdates("codex")).resolves.toBeNull();
    const done = settled(installations);
    installations.update("codex");
    await expect(done).resolves.toMatchObject({ operation: { status: "succeeded" } });

    const plain = new ProviderInstallations({
      logger: createTestLogger(),
      resolveClient: () => builtinClient({ updateUrl: "https://example.com/update" }),
    });
    await expect(plain.inspect("codex")).resolves.toEqual({
      updateUrl: "https://example.com/update",
    });
    expect(() => plain.update("codex")).toThrow("Provider codex cannot update itself");
    expect(plain.getUpdate("codex")).toBeNull();
  });

  test("closes admission and waits for the aborted updater to finish cleanup", async () => {
    const aborted = Promise.withResolvers<void>();
    const cleaned = Promise.withResolvers<void>();
    const { installations, invoked } = updating(async ({ signal }) => {
      signal.addEventListener("abort", aborted.resolve, { once: true });
      await aborted.promise;
      await cleaned.promise;
      return { status: "failed", message: "Update canceled." };
    });
    const done = settled(installations);
    installations.update("codex");
    await invoked;

    let closed = false;
    const closing = installations.close();
    void closing.then(() => {
      closed = true;
      return undefined;
    });
    await aborted.promise;
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(installations.close()).toBe(closing);
    expect(() => installations.update("codex")).toThrow("The daemon is stopping.");

    cleaned.resolve();
    await closing;
    expect(closed).toBe(true);
    await expect(done).resolves.toMatchObject({
      operation: { status: "failed", message: "Update canceled." },
    });
  });

  test("reports unconfirmed updater cleanup even if it was recorded before shutdown", async () => {
    const { installations } = updating(async ({ quarantineActivity }) => {
      quarantineActivity?.();
      return { status: "failed", message: "Could not confirm the updater process tree stopped." };
    });
    const done = settled(installations);
    installations.update("codex");
    await done;
    await expect(installations.close()).rejects.toBeInstanceOf(ProviderUpdateCleanupError);
  });
});
