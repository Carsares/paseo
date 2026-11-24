import { expect, test, vi } from "vitest";
import { supportsScopedProviderProcess } from "../../scoped-provider-process.js";
import { openCodeMajorVersion } from "./runtime-client.js";

async function prepareManagedCatalog(
  root: string,
  argv: [string, ...string[]],
  env: Record<string, string>,
) {
  const { prepareCustomProviderCliDiscovery } = await import("../../custom-provider-cli.js");
  return prepareCustomProviderCliDiscovery(
    { mode: "edit", providerId: "opencode" },
    await openCodeConfig(root, { opencode: { command: argv, env } }),
    root,
  );
}

async function openCodeConfig(
  root: string,
  providers: Record<string, import("../../provider-launch-config.js").ProviderOverride> = {},
) {
  const { DaemonConfigStore } = await import("../../../daemon-config-store.js");
  const configStore = new DaemonConfigStore(root, {
    mcp: { injectIntoAgents: false },
    providers,
    browserTools: { enabled: false },
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  });
  return { configStore, isRegisteredProvider: () => true, isPluginProvider: () => false };
}

const v2CatalogResponses = {
  "/api/info": { version: "2.0.10", pid: process.pid, urls: [], paths: { tmp: "/tmp" } },
  "/api/plugin": { data: [{ id: "test", state: { status: "active" } }] },
  "/api/agent": { data: [{ id: "test", name: "Test" }] },
  "/api/provider": { data: [{ id: "test" }] },
  "/api/model": {
    data: [
      {
        id: "model",
        modelID: "model",
        providerID: "test",
        name: "Test Model",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [],
        time: { released: 1 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 200000, output: 10000 },
      },
    ],
  },
};

test.skipIf(!supportsScopedProviderProcess())(
  "saves and refreshes an OpenCode v1 launcher without replacing the launcher of an open session",
  async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
    const { prepareCustomProviderCliDiscovery, runCustomProviderCliOperation } =
      await import("../../custom-provider-cli.js");
    const { buildProviderRegistry } = await import("../../provider-registry.js");
    const root = await mkdtemp(join(tmpdir(), "paseo-opencode-config-"));
    const launches = join(root, "launches");
    const config = { provider: "opencode", cwd: root } as const;
    const logger = createTestLogger();
    const clients: import("../../agent-sdk-types.js").AgentClient[] = [];
    const sessions: import("../../agent-sdk-types.js").AgentSession[] = [];
    vi.stubEnv("PASEO_HOME", root);
    try {
      const deps = await openCodeConfig(root);
      const getLaunches = async () =>
        (await readFile(launches, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      async function saveLauncher(id: string) {
        const script = join(root, id + ".cjs");
        await writeFile(
          script,
          `
          const id = ${JSON.stringify(id)};
          const env = process.env.TEST_OPENCODE_CONFIG;
          const args = process.argv.slice(2);
          require("node:fs").appendFileSync(${JSON.stringify(launches)},
            JSON.stringify([id, env, args.at(0)]) + "\\n");
          if (args.includes("--version")) {
            console.log("1.14.46");
          } else {
            const name = id + "-" + env;
            const server = require("node:http").createServer((request, response) => {
              const pathname = new URL(request.url, "http://127.0.0.1").pathname;
              if (pathname === "/global/event") {
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.write('data: {"payload":{"type":"server.connected","properties":{}}}\\n\\n');
                return;
              }
              const body = {
                "/session": { id: name, directory: ${JSON.stringify(root)} },
                "/command": [{ name }],
                "/provider": {
                  all: [{ id: "test", name: "Test", models: { [name]: { name } } }],
                  connected: ["test"],
                },
                "/agent": [{ name, mode: "primary" }],
              };
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify(body[pathname] ?? {}));
            });
            server.listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1", () =>
              console.log("listening on http://127.0.0.1:" + server.address().port)
            );
          }
          `,
        );
        const saved = await runCustomProviderCliOperation(
          "save",
          {
            mode: "edit",
            providerId: "opencode",
            command: [process.execPath, script],
            env: {
              TEST_OPENCODE_CONFIG: id + "-env",
              PASEO_OPENCODE_SERVER_URL: "",
              XDG_STATE_HOME: root,
            },
          },
          deps,
        );
        expect(saved).toEqual({ status: "ok" });
        const client = buildProviderRegistry(logger, {
          providerOverrides: deps.configStore.get().providers,
        }).opencode.createClient(logger);
        clients.push(client);
        return client;
      }

      const oldClient = await saveLauncher("old");
      await expect(readFile(launches)).rejects.toMatchObject({ code: "ENOENT" });
      const oldSession = await oldClient.createSession(config);
      sessions.push(oldSession);
      const original = await getLaunches();
      const nextClient = await saveLauncher("new");
      expect(await getLaunches()).toEqual(original);
      const binding = await prepareCustomProviderCliDiscovery(
        { mode: "edit", providerId: "opencode" },
        deps,
        root,
      );
      if (binding.status !== "ok") throw new Error("Managed discovery preparation failed");
      const catalog = await binding.run(() =>
        nextClient.fetchCatalog!({ scope: "workspace", cwd: root, force: true }),
      );
      expect(catalog.models.map(({ id }) => id)).toEqual(["test/new-new-env"]);
      const newSession = await nextClient.createSession(config);
      sessions.push(newSession);
      expect((await newSession.listCommands?.())?.map(({ name }) => name)).toContain("new-new-env");
      expect((await oldSession.listCommands?.())?.map(({ name }) => name)).toContain("old-old-env");
      expect(await getLaunches()).toEqual([
        ["old", "old-env", "--version"],
        ["old", "old-env", "serve"],
        ["new", "new-env", "--version"],
        ["new", "new-env", "serve"],
        ["new", "new-env", "--version"],
        ["new", "new-env", "serve"],
      ]);
    } finally {
      await Promise.allSettled(sessions.map((session) => session.close()));
      await Promise.allSettled(clients.map((client) => client.shutdown?.()));
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(!supportsScopedProviderProcess()).each([
  ["1.14.46", "catalog"],
  ["2.0.10", "catalog"],
  ["1.14.46", "abort"],
  ["2.0.10", "abort"],
] as const)(
  "reaps the verified OpenCode %s processes after %s",
  async (version, outcome) => {
    const { mkdtemp, readFile, realpath, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
    const { installationActivity } =
      await import("../../provider-installation/installation-activity.js");
    const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
    const root = await mkdtemp(join(tmpdir(), "paseo-managed-opencode-"));
    const script = join(root, "opencode.cjs");
    const invocations = join(root, "invocations");
    const versionGate = join(root, "version-ready");
    const serveGate = join(root, "serve-ready");
    const command: [string, ...string[]] = [process.execPath, script, "configured-argument"];
    const settings = {
      command: { mode: "replace" as const, argv: command },
      env: {
        XDG_CONFIG_HOME: root,
        XDG_STATE_HOME: root,
        PASEO_OPENCODE_SERVER_URL: "",
        OPENCODE_CONFIG_CONTENT: "{}",
        TEST_OPEN_CODE_ENV: "test-value",
      },
    };
    const client = new OpenCodeRuntimeClient(createTestLogger(), settings);
    const abort = new AbortController();
    vi.stubEnv("PASEO_HOME", root);
    let refresh: Promise<Awaited<ReturnType<typeof client.fetchCatalog>>> | undefined;
    const acquireUpdate = () =>
      installationActivity.acquireUpdate({ family: "opencode", keys: [] });
    const waitForInvocations = (count: number) =>
      vi.waitFor(async () => {
        const rows = (await readFile(invocations, "utf8")).trim().split("\n");
        expect(rows).toHaveLength(count);
        return rows.map((row) => JSON.parse(row));
      });
    try {
      await writeFile(
        script,
        `
        const args = process.argv.slice(2);
        const fs = require("node:fs");
        const worker = require("node:child_process").spawn(
          process.execPath, ["-e", "setTimeout(() => {}, 12000)"], { stdio: "inherit" }
        );
        worker.unref();
        fs.appendFileSync(
          ${JSON.stringify(invocations)},
          JSON.stringify([args, process.cwd(), process.env.TEST_OPEN_CODE_ENV, process.pid, worker.pid]) + "\\n"
        );
        const isVersion = args.includes("--version");
        const deadline = Date.now() + 7000;
        const wait = setInterval(() => {
          if (Date.now() > deadline) process.exit(1);
          if (!fs.existsSync(isVersion ? ${JSON.stringify(versionGate)} : ${JSON.stringify(serveGate)})) return;
          clearInterval(wait);
          if (isVersion) {
            console.log(${JSON.stringify(version)});
            return;
          }
          const responses = ${JSON.stringify({
            ...v2CatalogResponses,
            "/provider": {
              all: [{ id: "test", name: "Test", models: { model: { name: "Test Model" } } }],
              connected: ["test"],
            },
            "/agent": [{ name: "test", mode: "primary" }],
          })};
          const server = require("node:http").createServer((req, res) => {
            const value = responses[req.url.split("?")[0]];
            res.writeHead(value === undefined ? 404 : 200, { "content-type": "application/json" });
            res.end(JSON.stringify(value ?? {}));
          });
          server.listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1", () =>
            console.log("server listening on http://127.0.0.1:" + server.address().port)
          );
        }, 15);
        `,
      );
      const binding = await prepareManagedCatalog(root, command, settings.env);
      expect(binding.status).toBe("ok");
      if (binding.status !== "ok") throw new Error("Managed discovery preparation failed");
      const changedClient = new OpenCodeRuntimeClient(createTestLogger(), {
        ...settings,
        env: { ...settings.env, TEST_OPEN_CODE_ENV: "changed-after-binding" },
      });
      const options = { scope: "workspace", cwd: root, force: true } as const;
      try {
        await expect(binding.run(() => changedClient.fetchCatalog(options))).rejects.toThrow(
          /^OpenCode catalog discovery failed$/u,
        );
        await expect(readFile(invocations)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await changedClient.shutdown();
      }
      refresh = binding.run(() =>
        client.fetchCatalog(options, {
          signal: abort.signal,
          runActivity: (_, operation) => operation(),
        }),
      );
      void refresh.catch(() => undefined);
      const [probe] = await waitForInvocations(1);
      expect(() => acquireUpdate()).toThrow("installation is in use");
      await writeFile(versionGate, "");
      const [, serve] = await waitForInvocations(2);
      expect(() => process.kill(probe[4], 0)).toThrow();
      expect(() => acquireUpdate()).toThrow("installation is in use");
      if (outcome === "abort") {
        abort.abort();
        await expect(refresh).rejects.toThrow(/^OpenCode catalog discovery failed$/u);
      } else {
        await writeFile(serveGate, "");
        const catalog = await refresh;
        expect(catalog.models.map(({ id }) => id)).toEqual(["test/model"]);
        expect(catalog.modes.map(({ id }) => id)).toContain("test");
      }
      expect(probe.slice(0, 3)).toEqual([
        ["configured-argument", "--version"],
        await realpath(join(root, "opencode-home")),
        "test-value",
      ]);
      expect(serve.slice(0, 3)).toEqual([
        version.startsWith("1.")
          ? ["configured-argument", "serve", "--port", expect.stringMatching(/^\d+$/u)]
          : ["configured-argument", "serve", "--hostname", "127.0.0.1", "--port", "0"],
        await realpath(join(root, "opencode-home")),
        "test-value",
      ]);
      expect(() => process.kill(serve[3], 0)).toThrow();
      expect(() => process.kill(serve[4], 0)).toThrow();
      acquireUpdate().release();
    } finally {
      await Promise.all([writeFile(versionGate, ""), writeFile(serveGate, "")]);
      await refresh?.catch(() => undefined);
      vi.unstubAllEnvs();
      await client.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.each(["explicit", "registered"] as const)(
  "refreshes a %s OpenCode service without a local CLI and leaves it running",
  async (selection) => {
    const { createServer } = await import("node:http");
    const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
    const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
    const root = await mkdtemp(join(tmpdir(), "paseo-managed-opencode-shared-"));
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (
        request.headers.authorization !==
        `Basic ${Buffer.from("opencode:test-password").toString("base64")}`
      ) {
        response.writeHead(401).end();
        return;
      }
      const endpoint = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const result = v2CatalogResponses[endpoint as keyof typeof v2CatalogResponses];
      response.writeHead(result === undefined ? 404 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(result ?? {}));
    });
    const command = join(root, "missing-cli");
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test address");
      const url = `http://127.0.0.1:${address.port}`;
      const env =
        selection === "explicit"
          ? { PASEO_OPENCODE_SERVER_URL: url, PASEO_OPENCODE_SERVER_PASSWORD: "test-password" }
          : { PASEO_OPENCODE_SERVER_URL: "", XDG_STATE_HOME: root };
      if (selection === "registered") {
        await mkdir(join(root, "opencode"));
        await writeFile(
          join(root, "opencode", "service.json"),
          JSON.stringify({ url, password: "test-password", pid: process.pid, version: "2.0.10" }),
        );
      }
      const client = new OpenCodeRuntimeClient(createTestLogger(), {
        command: { mode: "replace", argv: [command] },
        env,
      });
      try {
        const binding = await prepareManagedCatalog(root, [command], env);
        expect(binding.status).toBe("ok");
        if (binding.status !== "ok") throw new Error("Managed discovery preparation failed");
        const catalog = await binding.run(() =>
          client.fetchCatalog({ scope: "workspace", cwd: root, force: true }),
        );
        expect(catalog.models.map(({ id }) => id)).toEqual(["test/model"]);
        expect(requests.some((request) => request.startsWith("/api/plugin?"))).toBe(true);
        expect(server.listening).toBe(true);
      } finally {
        await client.shutdown();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) return reject(error);
          resolve();
        });
        server.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!supportsScopedProviderProcess())(
  "reports managed OpenCode discovery failure when an owned CLI is missing",
  async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
    const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
    const root = await mkdtemp(join(tmpdir(), "paseo-managed-opencode-missing-"));
    const argv: [string] = [join(root, "missing-cli")];
    const env = { PASEO_OPENCODE_SERVER_URL: "", XDG_STATE_HOME: root };
    const client = new OpenCodeRuntimeClient(createTestLogger(), {
      command: { mode: "replace", argv },
      env,
    });
    vi.stubEnv("PASEO_HOME", root);
    try {
      const binding = await prepareManagedCatalog(root, argv, env);
      expect(binding.status).toBe("ok");
      if (binding.status !== "ok") throw new Error("Managed discovery preparation failed");
      await expect(
        binding.run(() => client.fetchCatalog({ scope: "workspace", cwd: root, force: true })),
      ).rejects.toThrow(/^OpenCode catalog discovery failed$/u);
    } finally {
      vi.unstubAllEnvs();
      await client.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("rejects owned discovery before preparing a launch on an unsupported host", async () => {
  const { access, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const root = await mkdtemp(join(tmpdir(), "paseo-managed-opencode-platform-"));
  const argv: [string, string] = [process.execPath, join(root, "cli.cjs")];
  const env = { PASEO_OPENCODE_SERVER_URL: "", XDG_STATE_HOME: root };
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv },
    env,
  });
  vi.stubEnv("PASEO_HOME", root);
  const platform = process.platform;
  try {
    const marker = join(root, "invoked");
    await writeFile(argv[1], `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");`);
    const binding = await prepareManagedCatalog(root, argv, env);
    if (binding.status !== "ok") throw new Error("Managed discovery preparation failed");
    Object.defineProperty(process, "platform", { value: "win32" });
    await expect(
      binding.run(() => client.fetchCatalog({ scope: "workspace", cwd: root, force: true })),
    ).rejects.toThrow("Managed discovery cannot start a local OpenCode process on this platform");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, "opencode-home"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    vi.unstubAllEnvs();
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["1.14.46", 1],
  ["unexpected wrapper output", 1],
  ["", 1],
  ["opencode v2.0.10\n", 2],
  ["v2.0.10-beta.1", 2],
])("identifies the OpenCode runtime version %s", (output, major) => {
  expect(openCodeMajorVersion(String(output))).toBe(major);
});

test.each(["3.0.0", "2.0.9", "2.0.7", "2.0.4", "2.0.3", "v2.0.1"])(
  "rejects unsupported OpenCode version output %s",
  (output) => {
    expect(() => openCodeMajorVersion(output)).toThrow();
  },
);

test("records the runtime once and retains its position across resume", async () => {
  const { withOpenCodeRuntimeNotice } = await import("./runtime-notice.js");
  const { V2Harness } = await import("./test-utils/v2-harness.js");
  const { OpenCodeV2AgentClient } = await import("./v2/agent.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const harness = new V2Harness();
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const original = withOpenCodeRuntimeNotice(
    await client.createSession({ provider: "opencode", cwd: "/tmp/project" }),
    2,
  );
  const notice = { type: "notification", level: "info", message: "This chat uses OpenCode v2." };
  try {
    expect(original.initialTimeline?.map((entry) => entry.item)).toEqual([notice]);
    const handle = original.describePersistence()!;
    await original.close();
    const resumed = withOpenCodeRuntimeNotice(await client.resumeSession(handle), 2, handle);
    try {
      expect(resumed.initialTimeline).toEqual([]);
      const history = [];
      for await (const event of resumed.streamHistory()) history.push(event);
      expect(history).toEqual([
        { type: "timeline", provider: "opencode", ...original.initialTimeline![0] },
      ]);
      expect(resumed.describePersistence()?.metadata?.openCodeRuntimeNotices).toEqual(
        handle.metadata?.openCodeRuntimeNotices,
      );
    } finally {
      await resumed.close();
    }
  } finally {
    await client.shutdown();
  }
});

test("retries a rejected version probe after the configured binary changes", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const root = await mkdtemp(join(tmpdir(), "opencode-version-probe-"));
  const script = join(root, "version.cjs");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, script] },
    env: { XDG_STATE_HOME: root },
  });
  try {
    await writeFile(script, 'console.log("opencode v2.0.3")');
    await expect(client.fetchCatalog({ scope: "global", force: true })).rejects.toThrow(
      "Update OpenCode to 2.0.10 or newer, then refresh the provider in Paseo",
    );
    await writeFile(script, 'console.log("opencode v3.0.0")');
    await expect(client.fetchCatalog({ scope: "global", force: true })).rejects.toThrow(
      "Unsupported OpenCode major version 3",
    );
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["console.log('wrapper output')", "unrecognized output"],
  ["process.exit(1)", "failed command"],
])("retries a %s version probe after updating to v2 (%s)", async (initialSource) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const root = await mkdtemp(join(tmpdir(), "opencode-version-retry-"));
  const script = join(root, "version.cjs");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, script] },
    env: { XDG_STATE_HOME: root },
  });
  try {
    await writeFile(script, initialSource);
    expect(
      (await client.listControls({ provider: "opencode", cwd: root })).controls[0]?.label,
    ).toBe("Auto Accept");
    await writeFile(script, 'console.log("opencode v2.0.10")');
    expect(
      (await client.listControls({ provider: "opencode", cwd: root })).controls[0]?.label,
    ).toBe("Auto-accept");
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("re-probes a v1 runtime on a forced refresh after OpenCode is updated to v2", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const root = await mkdtemp(join(tmpdir(), "opencode-version-upgrade-"));
  const script = join(root, "version.cjs");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, script] },
    env: { XDG_STATE_HOME: root },
  });
  const controlLabel = async () =>
    (await client.listControls({ provider: "opencode", cwd: root })).controls[0]?.label;
  try {
    await writeFile(script, 'console.log("1.14.46")');
    expect(await controlLabel()).toBe("Auto Accept");
    await writeFile(script, 'console.log("opencode v2.0.10")');
    expect(await controlLabel()).toBe("Auto Accept");

    // The fake binary cannot serve, so the refresh fails on the v2 startup path it switched to.
    await expect(client.fetchCatalog({ scope: "global", force: true })).rejects.toThrow(
      "OpenCode v2 server exited during startup",
    );

    expect(await controlLabel()).toBe("Auto-accept");
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

async function createCountingVersionBinary(prefix: string) {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const root = await mkdtemp(join(tmpdir(), prefix));
  const script = join(root, "version.cjs");
  const probes = join(root, "probes");
  await writeFile(probes, "");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, script] },
    env: { XDG_STATE_HOME: root },
  });
  return {
    client,
    root,
    report: (version: string) =>
      writeFile(
        script,
        `if (process.argv.includes("--version")) require("node:fs").appendFileSync(${JSON.stringify(probes)}, "x"); console.log(${JSON.stringify(version)})`,
      ),
    probeCount: async () => (await readFile(probes, "utf8")).length,
    controlLabel: async () =>
      (await client.listControls({ provider: "opencode", cwd: root })).controls[0]?.label,
    dispose: async () => {
      await client.shutdown();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("keeps a v2 runtime on a forced refresh without probing the binary again", async () => {
  const binary = await createCountingVersionBinary("opencode-v2-refresh-");
  try {
    await binary.report("opencode v2.0.10");
    expect(await binary.controlLabel()).toBe("Auto-accept");
    expect(await binary.probeCount()).toBe(1);

    await expect(binary.client.fetchCatalog({ scope: "global", force: true })).rejects.toThrow(
      "OpenCode v2 server exited during startup",
    );

    expect(await binary.probeCount()).toBe(1);
    expect(await binary.controlLabel()).toBe("Auto-accept");
  } finally {
    await binary.dispose();
  }
});

test.each([0, 1, 2, 3, 4, 5, 6, 8])(
  "probes once when a second forced refresh starts %i microtasks after the first",
  async (ticks) => {
    const binary = await createCountingVersionBinary("opencode-concurrent-refresh-");
    try {
      await binary.report("1.14.46");
      expect(await binary.controlLabel()).toBe("Auto Accept");
      await binary.report("opencode v2.0.10");

      const first = binary.client.fetchCatalog({ scope: "global", force: true });
      for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
      const second = binary.client.fetchCatalog({ scope: "global", force: true });
      const results = await Promise.allSettled([first, second]);

      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(await binary.probeCount()).toBe(2);
      expect(await binary.controlLabel()).toBe("Auto-accept");
    } finally {
      await binary.dispose();
    }
  },
);

test("appends a first notice after old history and records a changed major version", async () => {
  const { withOpenCodeRuntimeNotice } = await import("./runtime-notice.js");
  const { V2Harness } = await import("./test-utils/v2-harness.js");
  const { OpenCodeV2AgentClient } = await import("./v2/agent.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const harness = new V2Harness();
  harness.history.push({ id: "old", type: "user", text: "Earlier prompt", time: { created: 1 } });
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const previous = {
    provider: "opencode",
    sessionId: "session",
    metadata: { cwd: "/tmp/project" },
  };
  const session = withOpenCodeRuntimeNotice(await client.resumeSession(previous), 2, previous);
  try {
    const history = [];
    for await (const event of session.streamHistory()) history.push(event);
    expect(history).toEqual([
      expect.objectContaining({
        type: "timeline",
        item: { type: "user_message", text: "Earlier prompt", messageId: "old" },
      }),
      expect.objectContaining({
        type: "timeline",
        item: { type: "notification", level: "info", message: "This chat uses OpenCode v2." },
      }),
    ]);
    await session.close();
    const v1Handle = {
      ...previous,
      metadata: {
        ...previous.metadata,
        openCodeRuntimeNotices: [{ major: 1, timestamp: "2026-01-01T00:00:00.000Z" }],
      },
    };
    const changed = withOpenCodeRuntimeNotice(await client.resumeSession(v1Handle), 2, v1Handle);
    try {
      expect(changed.initialTimeline?.map((entry) => entry.item)).toEqual([
        { type: "notification", level: "info", message: "This chat uses OpenCode v2." },
      ]);
      expect(changed.describePersistence()?.metadata?.openCodeRuntimeNotices).toHaveLength(2);
    } finally {
      await changed.close();
    }
  } finally {
    await session.close();
    await client.shutdown();
  }
});

test.each([
  "process.exit(1)",
  'console.log("custom wrapper output")',
  "setTimeout(() => {}, 30000)",
])(
  "preserves legacy operations when the version probe is inconclusive: %s",
  async (source) => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
    const { OpenCodeAgentClient } = await import("../opencode-agent.js");
    const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
    const { OpenCodeServerManager } = await import("./server-manager.js");
    const root = await mkdtemp(join(tmpdir(), "opencode-legacy-probe-"));
    const script = join(root, "version.cjs");
    await writeFile(script, source);
    const logger = createTestLogger();
    let legacyShutdown = false;
    class TrackedServerManager extends OpenCodeServerManager {
      override async shutdown() {
        legacyShutdown = true;
        await super.shutdown();
      }
    }
    const client = new OpenCodeRuntimeClient(
      logger,
      {
        command: { mode: "replace", argv: [process.execPath, script] },
        env: { XDG_STATE_HOME: root },
      },
      { serverManager: new TrackedServerManager({ logger }) },
    );
    const legacy = new OpenCodeAgentClient(logger);
    const config = { provider: "opencode", cwd: root };
    try {
      expect(await client.listControls(config)).toEqual(await legacy.listControls(config));
    } finally {
      await client.shutdown();
      await legacy.shutdown();
      await rm(root, { recursive: true, force: true });
    }
    expect(legacyShutdown).toBe(true);
  },
  10000,
);

test("selects v2 without probing the binary when an external server is configured", async () => {
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, "-e", "process.exit(1)"] },
    env: {
      PASEO_OPENCODE_SERVER_URL: "http://127.0.0.1:4096",
      PASEO_OPENCODE_SERVER_PASSWORD: "test-password",
    },
  });
  try {
    const { controls } = await client.listControls({ provider: "opencode", cwd: "/tmp/project" });
    expect(controls.map((control) => control.label)).toEqual(["Auto-accept"]);
    await expectExternalInstallation(client.installation);
  } finally {
    await client.shutdown();
  }
});

async function expectExternalInstallation(
  installation: import("../../agent-sdk-types.js").AgentClientInstallation,
) {
  const signal = new AbortController().signal;
  const message = "Update OpenCode on the host that manages the connected server.";
  await expect(installation.getMaintenance!({ signal })).resolves.toEqual({
    kind: "external",
    message,
  });
  await expect(installation.inspect!({ signal })).resolves.toEqual({ status: "installed" });
  await expect(
    installation.update!({
      signal,
      report: () => {
        throw new Error("The local updater must not start for an external server");
      },
    }),
  ).resolves.toEqual({ status: "failed", message });
}

test.each(["external", "owned", "external during inspection"] as const)(
  "reports a consistent installation for OpenCode service selection: %s",
  async (selected) => {
    const { createServer } = await import("node:http");
    const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
    const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
    const { ProviderInstallations } =
      await import("../../provider-installation/provider-installations.js");
    const root = await mkdtemp(join(tmpdir(), "opencode-external-maintenance-"));
    const server = createServer((request, response) => {
      if (
        request.headers.authorization !==
        `Basic ${Buffer.from("opencode:test-password").toString("base64")}`
      ) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ version: "2.0.10", pid: process.pid }));
    });
    try {
      const state = join(root, "opencode");
      await mkdir(state);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test address");
      const registration = join(state, "service.json");
      const publish = () =>
        writeFile(
          registration,
          JSON.stringify({
            url: `http://127.0.0.1:${address.port}`,
            password: "test-password",
            pid: process.pid,
            version: "2.0.10",
          }),
        );
      const script = join(root, "version.cjs");
      await writeFile(script, 'console.log("opencode 1.19.5")');
      const logger = createTestLogger();
      const client = new OpenCodeRuntimeClient(logger, {
        command: { mode: "replace", argv: [process.execPath, script] },
        env: { XDG_STATE_HOME: root, PASEO_OPENCODE_SERVER_URL: "" },
      });
      const installations = new ProviderInstallations({
        logger,
        resolveClient: () => client,
        now: () => 0,
      });
      const inspect = () => installations.inspect("opencode");
      const localInstallation = {
        inspection: { status: "installed", version: "1.19.5" },
        maintenance: { kind: "manual" },
      };
      const externalInstallation = {
        maintenance: { kind: "external" },
      };
      try {
        const controls = () => client.listControls({ provider: "opencode", cwd: root });
        if (selected === "external during inspection") {
          const diagnostics = await import("../diagnostic-utils.js");
          const started = Promise.withResolvers<void>();
          const finish = Promise.withResolvers<string>();
          const version = vi
            .spyOn(diagnostics, "readCommandVersionOutput")
            .mockImplementationOnce(async () => {
              started.resolve();
              return finish.promise;
            });
          const localRead = inspect();
          try {
            await Promise.race([
              started.promise,
              localRead.then(() => {
                throw new Error("Inspection finished without reading the local version");
              }),
            ]);
            await publish();
            expect((await controls()).controls[0]?.label).toBe("Auto-accept");
            const externalRead = inspect();
            finish.resolve("opencode 1.19.5");
            await expect(localRead).resolves.toMatchObject(localInstallation);
            const current = await externalRead;
            expect(current).toMatchObject(externalInstallation);
            expect(current?.inspection).toEqual({ status: "installed" });
          } finally {
            finish.resolve("opencode 1.19.5");
            await localRead;
            version.mockRestore();
          }
        } else if (selected === "external") {
          await expect(inspect()).resolves.toMatchObject(localInstallation);
          await publish();
          await expectExternalInstallation(client.installation);
          expect((await controls()).controls[0]?.label).toBe("Auto-accept");
        } else {
          expect((await controls()).controls[0]?.label).toBe("Auto Accept");
          await expect(inspect()).resolves.toMatchObject(localInstallation);
          await publish();
          await expect(installations.inspect("opencode", { refresh: true })).resolves.toMatchObject(
            localInstallation,
          );
          expect((await controls()).controls[0]?.label).toBe("Auto Accept");
          return;
        }
        const current = await inspect();
        expect(current).toMatchObject(externalInstallation);
        expect(current?.inspection).toEqual({ status: "installed" });
        await rm(registration);
        const refreshed = await installations.inspect("opencode", { refresh: true });
        expect(refreshed).toMatchObject(externalInstallation);
        expect(refreshed?.inspection).toEqual({ status: "installed" });
        await expectExternalInstallation(client.installation);
        expect((await controls()).controls[0]?.label).toBe("Auto-accept");
      } finally {
        await client.shutdown();
      }
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("keeps native Paseo tools available when an external server is configured", async () => {
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const { OpenCodeBridge } = await import("./bridge.js");
  const bridge = new OpenCodeBridge({ paseoHome: "/tmp", logger: createTestLogger() });
  const external = new OpenCodeRuntimeClient(
    createTestLogger(),
    { env: { PASEO_OPENCODE_SERVER_URL: "http://127.0.0.1:4096" } },
    { bridge },
  );
  const local = new OpenCodeRuntimeClient(createTestLogger(), undefined, { bridge });
  try {
    expect(external.capabilities.supportsNativePaseoTools).toBe(true);
    expect(local.capabilities.supportsNativePaseoTools).toBe(true);
  } finally {
    await external.shutdown();
    await local.shutdown();
  }
});
