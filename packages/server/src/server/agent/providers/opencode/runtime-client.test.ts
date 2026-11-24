import { expect, test, vi } from "vitest";
import { openCodeMajorVersion } from "./runtime-client.js";

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
