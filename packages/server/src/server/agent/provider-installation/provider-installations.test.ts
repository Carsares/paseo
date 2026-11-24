import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentManager } from "../agent-manager.js";
import { createTestAgentClient } from "../../test-utils/fake-agent-client.js";
import { installationActivity, InstallationActivity } from "./installation-activity.js";
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
import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentClient, AgentClientInstallation } from "../agent-sdk-types.js";
import { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import {
  ProviderInstallations,
  ProviderUpdateCleanupError,
  type ProviderUpdateEvent,
} from "./provider-installations.js";

const OPAQUE_VERSION = "  v1.2.3-beta+weird (build 7)\n";
const MISSING_COMMAND = "paseo-provider-installation-missing-binary";
const OPAQUE_VERSIONS = ["v9-nightly+abc", "  2.0 (LTS)\n"];
const OPAQUE_MESSAGE = "  Restart to finish updating\n";

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

  function settled(installations: ProviderInstallations): Promise<ProviderInstallationUpdate> {
    return new Promise((resolve) => {
      const stop = installations.observeUpdates("codex", (event) => {
        if (event.type !== "provider.installation.update.progress") return;
        if (event.payload.operation.status === "running") return;
        stop();
        resolve(installations.getUpdate("codex")!);
      });
    });
  }

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

  test.each(["prepared", "published before spawn", "published after spawn"] as const)(
    "checks the published provider config when a replacement is %s",
    async (replacement) => {
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
          codex: { label: "New configuration" },
        });

        if (replacement === "published before spawn") next.commit();
        allowSpawn.resolve();
        if (replacement === "published after spawn") {
          await started.promise;
          next.commit();
        }
        allowResult.resolve();
        const result = await done;
        if (replacement === "published before spawn") {
          expect(launch).not.toHaveBeenCalled();
          expect(result.operation).toMatchObject({
            status: "failed",
            message: "Provider configuration changed. Inspect the installation and retry.",
          });
        } else {
          expect(launch).toHaveBeenCalledTimes(1);
          expect(result.operation).toMatchObject({
            status: "succeeded",
            outcome: replacement === "prepared" ? "updated" : "unverified",
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
    let finish!: () => void;
    let attempt = 0;
    const { installations } = updating(
      async () => {
        attempt += 1;
        if (attempt === 1) return { status: "failed", message: "EACCES" };
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
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
    finish();
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
