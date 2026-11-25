import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { installationActivity } from "../../../provider-installation/installation-activity.js";
import { OpenCodeBridge } from "../bridge.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { provisionLocalBridge } from "./bridge-provisioning.js";
import { V2Runtime } from "./runtime.js";
import { OpenCodeV2Session } from "./session.js";

test("lists cached commands after an exit without acquiring a new v2 connection", async () => {
  const old = new V2Harness();
  const replacement = new V2Harness();
  old.api.command.list = vi.fn(async ({ location }) => ({ location, data: [] }));
  old.api.skill.list = async ({ location }) => ({ location, data: [] });
  replacement.api.command.list = vi.fn(async ({ location }) => ({ location, data: [] }));
  replacement.api.skill.list = async ({ location }) => ({ location, data: [] });
  const exited = Promise.withResolvers<Error>();
  const acquire = vi.fn(async () => replacement.connection);
  const session = new OpenCodeV2Session({
    connection: { ...old.connection, exited: exited.promise },
    info: old.info,
    config: { provider: "opencode", cwd: old.info.location.directory },
    logger: createTestLogger(),
    persist: true,
    requiresPaseoPlugin: false,
    acquire,
  });
  try {
    await session.initialize();
    const commands = await session.listCommands({ allowLaunch: false });
    expect(commands.map(({ name }) => name)).toContain("compact");
    exited.resolve(new Error("Test helper exited"));
    await exited.promise;
    expect(await session.listCommands({ allowLaunch: false })).toEqual(commands);
    expect(old.api.command.list).toHaveBeenCalledTimes(1);
    expect(acquire).not.toHaveBeenCalled();
    expect(await session.listCommands()).toEqual(commands);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(replacement.api.command.list).toHaveBeenCalledTimes(1);
  } finally {
    await session.close();
  }
});

test("an owned helper reuses its installed bridge and keeps the installation occupied while idle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-owned-opencode-"));
  const config = path.join(root, "config", "opencode");
  const script = path.join(root, "server.cjs");
  const record = path.join(root, "env.json");
  const bridge = new OpenCodeBridge({ paseoHome: root, logger: createTestLogger() });
  await bridge.start();
  const artifact = fileURLToPath(await bridge.materializeV2Plugin());
  await provisionLocalBridge({
    configDirectory: config,
    artifact: path.join(artifact, "server.js"),
  });
  await writeFile(
    script,
    `
    const http = require('node:http');
    require('node:fs').writeFileSync(${JSON.stringify(record)}, process.env.OPENCODE_CONFIG_CONTENT);
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
  `,
  );
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    bridge,
    selection: { kind: "owned" },
    settings: {
      command: { mode: "replace", argv: [process.execPath, script] },
      env: { XDG_CONFIG_HOME: path.join(root, "config"), OPENCODE_CONFIG_CONTENT: "{}" },
    },
  });
  const acquireUpdate = () => installationActivity.acquireUpdate({ family: "opencode", keys: [] });
  const update = acquireUpdate();
  vi.stubEnv("PASEO_HOME", root);
  try {
    try {
      await expect(runtime.acquire()).rejects.toThrow("installation is being updated");
    } finally {
      update.release();
    }
    const first = await runtime.acquire();
    const pid = (await first.client.server.info()).pid;
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({});
    await first.release();
    expect(acquireUpdate).toThrow("installation is in use");
    const refreshed = await runtime.acquire({ fresh: true });
    expect((await refreshed.client.server.info()).pid).toBe(pid);
    await refreshed.release();
    await runtime.shutdown();
    await vi.waitFor(() => acquireUpdate().release());
  } finally {
    await runtime.shutdown();
    await bridge.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("reports a bridge port change that has not been applied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-port-"));
  const bridge = new OpenCodeBridge({ paseoHome: root, logger: createTestLogger() });
  await bridge.start();
  const actual = Number(new URL(bridge.sharedV2Connection().baseUrl).port);
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    bridge,
    selection: { kind: "explicit", server: { url: "http://127.0.0.1:1" } },
    settings: { env: { PASEO_OPENCODE_BRIDGE_PORT: actual === 1 ? "2" : "1" } },
  });
  try {
    await expect(runtime.acquire()).rejects.toThrow("restart Paseo to apply the bridge port");
  } finally {
    await runtime.shutdown();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
