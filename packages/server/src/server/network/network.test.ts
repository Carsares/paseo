import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { on, once } from "node:events";
import { connect } from "node:net";
import { afterEach, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { initializeEnvironmentProxy, webSocketProxyAgent } from "./index.js";
import { installHostProxyDispatcher, onLegacyControlRoute } from "./host-proxy-dispatch.js";
import { FileHostProxySettingsStore, openStoredHostProxy } from "./host-proxy-store.js";
import { readConfirmedLanPeers } from "./host-proxy-trust.js";
import { isProtectedProxyIngress } from "./host-proxy-ingress.js";
import { createProxyPolicy } from "./proxy-policy.js";
import { EncryptedProxyCredentialStore } from "./proxy-credential-store.js";
import { ConnectedHosts } from "../connected-hosts/index.js";
import { DirectHubRelationshipRemote } from "../hub/relationship-remote.js";
import type { HostSummary } from "@getpaseo/protocol/hosts";
const original = getGlobalDispatcher();
const servers: Server[] = [];
afterEach(async () => {
  const installed = getGlobalDispatcher();
  setGlobalDispatcher(original);
  if (installed !== original) await installed.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return `127.0.0.1:${address.port}`;
}
async function proxy() {
  const tunnels: string[] = [];
  const server = createServer();
  server.on("connect", (request, socket) => {
    tunnels.push(request.url!);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  return { url: `http://${await listen(server)}`, tunnels };
}

test("classifies a real IPC socket separately from local TCP", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "px-"));
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\${path.basename(home)}`
      : path.join(home, "ws.sock");
  const local = createServer();
  servers.push(local);
  try {
    local.listen(address);
    await once(local, "listening");
    const accepted = once(local, "connection");
    const client = connect(address);
    try {
      const [socket] = await accepted;
      expect(isProtectedProxyIngress(local.address(), socket)).toBe(true);
    } finally {
      client.destroy();
    }
  } finally {
    await new Promise<void>((resolve) => local.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test("reopens stored proxy settings and keeps local and legacy control dispatch separate", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "daemon-outbound-proxy-"));
  const legacy = await proxy();
  const manual = await proxy();
  initializeEnvironmentProxy({ HTTPS_PROXY: legacy.url });
  let opened: Awaited<ReturnType<typeof openStoredHostProxy>> | undefined;
  let restore: (() => Promise<void>) | undefined;
  try {
    opened = await openStoredHostProxy(home, () => []);
    const first = new FileHostProxySettingsStore(path.join(home, "outbound-proxy"));
    const second = new FileHostProxySettingsStore(path.join(home, "outbound-proxy"));
    const candidate = {
      revision: 1,
      current: { settings: { mode: "manual", proxy: { kind: "unified", url: manual.url } } },
    } as const;
    await expect(first.compareAndSet(0, candidate, () => false)).rejects.toThrow(
      "Proxy source no longer authorized",
    );
    expect(await first.load()).toBeUndefined();
    const written = await Promise.all([
      first.compareAndSet(0, candidate),
      second.compareAndSet(0, candidate),
    ]);
    expect(written.filter(Boolean)).toHaveLength(1);
    await opened.close();
    opened = await openStoredHostProxy(home, () => []);
    expect(opened.runtime.read()).toMatchObject({
      revision: 1,
      settings: candidate.current.settings,
    });
    restore = installHostProxyDispatcher(opened.runtime);
    const address = await listen(createServer((_, response) => response.end("local")));
    expect(await (await fetch(`http://${address}`)).text()).toBe("local");
    const fetchRemote = () =>
      fetch("https://vendor.invalid", { signal: AbortSignal.timeout(1_000) });
    await expect(fetchRemote()).rejects.toThrow();
    await expect(onLegacyControlRoute(fetchRemote)).rejects.toThrow();
    expect(manual.tunnels).toEqual(["vendor.invalid:443"]);
    expect(legacy.tunnels).toEqual(["vendor.invalid:443"]);

    const hubAddress = await listen(
      createServer((request, response) => {
        response
          .writeHead(307, { location: `https://${request.method?.toLowerCase()}.hub.invalid` })
          .end();
      }),
    );
    const hubOrigin = `http://${hubAddress}`;
    const hub = new DirectHubRelationshipRemote({ requestTimeoutMs: 5_000 });
    const daemonId = "daemon-fixture";
    const credential = "hub-fixture";
    await expect(
      onLegacyControlRoute(() =>
        hub.enroll({
          hubOrigin,
          daemonId,
          token: credential,
          idempotencyKey: "enrollment-fixture",
          hostname: "test",
          serverId: "test",
          daemonPublicKey: "test",
          credentialVerifier: "test",
          permissions: [],
        }),
      ),
    ).rejects.toThrow();
    await expect(
      onLegacyControlRoute(() =>
        hub.updatePermissions({ hubOrigin, daemonId, credential, permissions: [] }),
      ),
    ).rejects.toThrow();
    await expect(
      onLegacyControlRoute(() => hub.revoke({ hubOrigin, daemonId, credential })),
    ).rejects.toThrow();
    const legacyBeforeUnavailable = [
      "vendor.invalid:443",
      "post.hub.invalid:443",
      "patch.hub.invalid:443",
      "delete.hub.invalid:443",
    ];
    expect(legacy.tunnels).toEqual(legacyBeforeUnavailable);
    expect(manual.tunnels).toEqual(["vendor.invalid:443"]);

    await restore();
    restore = installHostProxyDispatcher(undefined);
    expect(await (await fetch(`http://${address}`)).text()).toBe("local");
    await expect(fetchRemote()).rejects.toThrow();
    await expect(onLegacyControlRoute(fetchRemote)).rejects.toThrow();
    expect(manual.tunnels).toEqual(["vendor.invalid:443"]);
    expect(legacy.tunnels).toEqual([...legacyBeforeUnavailable, "vendor.invalid:443"]);
  } finally {
    await restore?.();
    await opened?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("preserves the accepted TCP scheme through reconnect and requires a new acceptance after a scheme change", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "daemon-lan-proxy-"));
  const paired: HostSummary = {
    registrationId: "paired",
    serverId: "peer",
    label: null,
    source: { id: "owner", key: "paired" },
    metadata: {},
    enabled: true,
    status: "online",
    targetDescription: "tcp://192.168.1.2:7443",
    lastOnlineAt: "2026-01-01T00:00:00.000Z",
    nextRetryAt: null,
    error: null,
  };
  const connection = "tcp://192.168.1.2:7443?ssl=true";
  const reconnecting = { ...paired, status: "connecting" } as const;
  const directory = (host: HostSummary) => ({
    self: { serverId: "self", label: "self" },
    hosts: [host],
  });
  const save = (host: HostSummary, address = connection) =>
    writeFile(path.join(home, "hosts.json"), JSON.stringify([{ ...host, connection: address }]), {
      mode: 0o600,
    });
  try {
    await save(paired);
    const confirmed = await readConfirmedLanPeers(home, directory(reconnecting), new Map());
    expect([...confirmed.values()]).toEqual([
      { serverId: "peer", origin: "wss://192.168.1.2:7443", lastOnlineAt: paired.lastOnlineAt },
    ]);
    const policy = createProxyPolicy({
      bypass: [],
      trustedLanOrigins: [...confirmed.values()].map((peer) => peer.origin),
    });
    expect(policy("wss://192.168.1.2:7443").bypass).toBe(true);
    expect(policy("ws://192.168.1.2:7443").bypass).toBe(false);
    expect(policy("wss://192.168.1.2:7444").bypass).toBe(false);

    const offline = { ...paired, status: "offline" } as const;
    await save(offline);
    expect(await readConfirmedLanPeers(home, directory(offline), confirmed)).toEqual(confirmed);

    await save(reconnecting, "tcp://192.168.1.2:7443");
    expect((await readConfirmedLanPeers(home, directory(reconnecting), confirmed)).size).toBe(0);

    await save(paired);
    expect(
      (await readConfirmedLanPeers(home, directory({ ...paired, enabled: false }), confirmed)).size,
    ).toBe(0);
    expect(
      (await readConfirmedLanPeers(home, directory({ ...paired, serverId: null }), confirmed)).size,
    ).toBe(0);
    expect(
      (await readConfirmedLanPeers(home, directory({ ...paired, status: "error" }), confirmed))
        .size,
    ).toBe(0);

    const publicHost = { ...paired, targetDescription: "wss://vendor.invalid" };
    await save(publicHost, "wss://vendor.invalid");
    expect((await readConfirmedLanPeers(home, directory(publicHost), confirmed)).size).toBe(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("loopback fetch and WebSockets bypass HTTP_PROXY with empty NO_PROXY", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy({ HTTP_PROXY: recorder.url, NO_PROXY: "" });
  const server = createServer((_, response) => response.end("direct"));
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.send("direct"));
  const address = await listen(server);
  expect(await (await fetch(`http://${address}`)).text()).toBe("direct");
  const socket = new WebSocket(`ws://${address}`, {
    agent: webSocketProxyAgent(`ws://${address}`),
  });
  expect((await once(socket, "message"))[0].toString()).toBe("direct");
  socket.close();
  await once(socket, "close");
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  for (const host of ["localhost", "127.0.0.1", "[::1]"])
    expect(webSocketProxyAgent(`wss://${host}:1234`)).toBeUndefined();
  expect(recorder.tunnels).toEqual([]);
});
test("fetch and WebSockets send non-loopback traffic through CONNECT", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy({ http_proxy: recorder.url });
  await expect(
    fetch("https://vendor.invalid/", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  const socket = new WebSocket("wss://vendor.invalid", {
    agent: webSocketProxyAgent("wss://vendor.invalid"),
  });
  await once(socket, "error");
  expect(
    recorder.tunnels.filter((host) => host === "vendor.invalid:443").length,
  ).toBeGreaterThanOrEqual(2);
});
test("NO_PROXY and absent variables keep matching WebSockets direct", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy({
    HTTPS_PROXY: recorder.url,
    NO_PROXY: "vendor.invalid,.example.invalid:443",
  });
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeUndefined();
  await expect(
    fetch("https://vendor.invalid/", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  expect(webSocketProxyAgent("wss://sub.example.invalid")).toBeUndefined();
  expect(webSocketProxyAgent("wss://example.invalid:444")).toBeDefined();
  initializeEnvironmentProxy({ HTTP_PROXY: recorder.url, no_proxy: "*" });
  expect(webSocketProxyAgent("ws://vendor.invalid")).toBeUndefined();
  initializeEnvironmentProxy({});
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeUndefined();
  const address = await listen(createServer((_, response) => response.end("direct")));
  expect(await (await fetch(`http://${address}`)).text()).toBe("direct");
  expect(recorder.tunnels).toEqual([]);
});

test.each(["127.0.0.1", "localhost"])(
  "scheme-less %s proxies work for fetch and WebSockets",
  async (host) => {
    const recorder = await proxy();
    const address = new URL(recorder.url);
    initializeEnvironmentProxy({ https_proxy: `${host}:${address.port}` });
    await expect(
      fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    const socket = new WebSocket("wss://vendor.invalid", {
      agent: webSocketProxyAgent("wss://vendor.invalid"),
    });
    await once(socket, "error");
    expect(recorder.tunnels).toContain("vendor.invalid:443");
  },
);

test.each([
  "http://[",
  "http://user%zz:secret@proxy.corp",
  "socks5://127.0.0.1:7890",
  "ftp://proxy.corp:8080",
])("ignores invalid or unsupported proxy %s without stopping startup", async (value) => {
  const recorder = await proxy();
  expect(initializeEnvironmentProxy({ HTTP_PROXY: recorder.url, https_proxy: value })).toEqual([
    "https_proxy",
  ]);
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeDefined();
  await expect(
    fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  const socket = new WebSocket("wss://vendor.invalid", {
    agent: webSocketProxyAgent("wss://vendor.invalid"),
  });
  await once(socket, "error");
  expect(recorder.tunnels).toEqual(["vendor.invalid:443", "vendor.invalid:443"]);
});

test.each(["saved settings", "unreadable credential key"] as const)(
  "the daemon worker preserves control access with %s",
  async (startup) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "daemon-invalid-proxy-"));
    const recorder = await proxy();
    const legacy = await proxy();
    const persisted = await openStoredHostProxy(home, () => []);
    await persisted.close();
    const settings = { mode: "manual", proxy: { kind: "unified", url: recorder.url } } as const;
    const directory = path.join(home, "outbound-proxy");
    const store = new FileHostProxySettingsStore(directory);
    const credentials = new EncryptedProxyCredentialStore(path.join(directory, "credentials"), () =>
      readFile(path.join(directory, "credential.key")),
    );
    const credentialId = await credentials.write({
      unified: { username: "fake-proxy-user", password: "fake-proxy-password" },
    });
    expect(await store.compareAndSet(0, { revision: 1, current: { settings, credentialId } })).toBe(
      true,
    );
    const brokenKey = Buffer.from("invalid-test-key");
    const keyPath = path.join(directory, "credential.key");
    if (startup === "unreadable credential key") await writeFile(keyPath, brokenKey);
    const worker = fork(fileURLToPath(new URL("../daemon-worker.ts", import.meta.url)), [], {
      execArgv: ["--conditions=source", "--import", "tsx"],
      silent: true,
      env: {
        PATH: process.env.PATH,
        DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH,
        PASEO_HOME: home,
        HOME: home,
        USERPROFILE: home,
        PASEO_LISTEN: "127.0.0.1:0",
        PASEO_RELAY_ENABLED: "0",
        PASEO_WEB_UI_ENABLED: "0",
        PASEO_LOG_FORMAT: "json",
        HTTP_PROXY: legacy.url,
        https_proxy: "socks5://private:secret@127.0.0.1:7890",
      },
    });
    let workerOutput = "";
    worker.stdout?.on("data", (chunk: Buffer) => {
      workerOutput += chunk.toString();
    });
    worker.stderr?.resume();
    const deadline = AbortSignal.timeout(20_000);
    const sockets: WebSocket[] = [];
    try {
      const ready = new Promise<string>((resolve) => {
        worker.on("message", (message) => {
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "paseo:ready" &&
            "listen" in message &&
            typeof message.listen === "string"
          )
            resolve(message.listen);
        });
      });
      const workerAddress = await Promise.race([
        ready,
        once(worker, "exit", { signal: deadline }).then(([code]) => {
          throw new Error(`Worker exited ${code} before becoming ready`);
        }),
      ]);
      expect(workerAddress).toMatch(/^127\.0\.0\.1:[1-9]\d*$/);
      const status = await fetch(`http://${workerAddress}/api/status`, { signal: deadline });
      expect(status.ok).toBe(true);
      const available = startup === "saved settings";
      const httpStatus = await status.json();
      expect(httpStatus.features?.outboundProxy).toBe(available ? true : undefined);

      async function connectClient() {
        const socket = new WebSocket(`ws://${workerAddress}/ws`, {
          headers: { "X-Forwarded-Proto": "https" },
        });
        sockets.push(socket);
        const pending = once(socket, "message", { signal: deadline });
        await once(socket, "open", { signal: deadline });
        socket.send(
          JSON.stringify({
            type: "hello",
            clientId: "clid_test_proxy",
            clientType: "cli",
            protocolVersion: 1,
          }),
        );
        const [message] = await pending;
        expect(JSON.parse(message.toString())).toMatchObject({
          type: "session",
          message: {
            type: "status",
            payload: { status: "server_info" },
          },
        });
        expect(JSON.parse(message.toString()).message.payload.features?.outboundProxy).toBe(
          available ? true : undefined,
        );
        return socket;
      }

      const requester = await connectClient();
      const request = async (
        socket: WebSocket,
        requestId: string,
        message: object = { type: "daemon.network.get_proxy.request" },
      ) => {
        const frames = on(socket, "message", { signal: deadline });
        socket.send(
          JSON.stringify({
            type: "session",
            message: { ...message, requestId },
          }),
        );
        for await (const [incoming] of frames) {
          const frame = incoming.toString();
          if (JSON.parse(frame).message?.payload?.requestId === requestId) return frame;
        }
        throw new Error("Proxy request did not receive a correlated reply");
      };
      if (!available) {
        const frame = await request(requester, "storage-failure");
        expect(JSON.parse(frame)).toMatchObject({
          type: "session",
          message: {
            type: "daemon.network.get_proxy.response",
            payload: { requestId: "storage-failure", result: { status: "unavailable" } },
          },
        });
        expect(await readFile(keyPath)).toEqual(brokenKey);
        expect(recorder.tunnels).toEqual([]);
        expect(legacy.tunnels).toEqual([]);
        return;
      }
      const other = await connectClient();
      const otherReplies: string[] = [];
      other.on("message", (frame) => {
        const { message } = JSON.parse(frame.toString());
        if (message?.type === "daemon.network.get_proxy.response")
          otherReplies.push(message.payload.requestId);
      });
      for (const [socket, requestId] of [
        [requester, "first"],
        [other, "second"],
      ] as const) {
        const frame = await request(socket, requestId);
        expect(frame).not.toContain("fake-proxy-password");
        expect(frame).not.toContain(credentialId);
        expect(JSON.parse(frame)).toMatchObject({
          type: "session",
          message: {
            type: "daemon.network.get_proxy.response",
            payload: {
              requestId,
              result: {
                status: "loaded",
                snapshot: {
                  access: "edit",
                  revision: 1,
                  settings,
                  credentialSlots: ["unified"],
                  supportsCredentialReplacement: false,
                },
              },
            },
          },
        });
      }
      expect(otherReplies).toEqual(["second"]);
      const replacementFrame = await request(requester, "tcp-replacement", {
        type: "daemon.network.test_proxy.request",
        expectedRevision: 1,
        settings,
        credentials: {
          unified: {
            action: "replace",
            credential: { username: "fixture", password: "replacement-fixture" },
          },
        },
      });
      expect(JSON.parse(replacementFrame)).toMatchObject({
        message: {
          type: "daemon.network.test_proxy.response",
          payload: { result: { status: "denied" } },
        },
      });
      expect(replacementFrame.includes("replacement-fixture")).toBe(false);
      const invalidId = "invalid-proxy-test";
      const fixturePassword = "invalid-proxy-password-fixture";
      const invalidFrame = await request(requester, invalidId, {
        type: "daemon.network.test_proxy.request",
        expectedRevision: "malformed",
        settings: {
          mode: "manual",
          proxy: { kind: "unified", url: `http://fixture:${fixturePassword}@proxy.invalid` },
        },
        credentials: {
          unified: {
            action: "replace",
            credential: { username: "fixture", password: fixturePassword },
          },
        },
      });
      expect(JSON.parse(invalidFrame)).toMatchObject({
        type: "session",
        message: { type: "rpc_error", payload: { requestId: invalidId } },
      });
      expect(invalidFrame.includes(fixturePassword)).toBe(false);
      await expect
        .poll(() =>
          workerOutput
            .split("\n")
            .some(
              (line) => line.includes(invalidId) && line.includes("Invalid configuration request"),
            ),
        )
        .toBe(true);
      expect(workerOutput.includes(fixturePassword)).toBe(false);
      // A startup request reaches only the local CONNECT recorder.
      await expect.poll(() => recorder.tunnels.length, { timeout: 5_000 }).toBeGreaterThan(0);
      const log = await readFile(path.join(home, "daemon.log"), "utf8");
      const warnings = log
        .split("\n")
        .filter((line) => line.includes("Ignoring invalid or unsupported HTTP proxy variable"));
      expect(warnings).toHaveLength(1);
      expect(JSON.parse(warnings[0]!).variable).toBe("https_proxy");
      expect(warnings[0]).not.toContain("secret");
    } finally {
      for (const socket of sockets) socket.terminate();
      if (worker.exitCode === null && worker.signalCode === null) {
        const exited = once(worker, "exit");
        worker.kill("SIGTERM");
        const forceExit = setTimeout(() => worker.kill("SIGKILL"), 6_000);
        try {
          expect(await exited).toEqual([0, null]);
        } finally {
          clearTimeout(forceExit);
        }
      }
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);

test("accepts a scheme-less corporate proxy hostname", () => {
  expect(initializeEnvironmentProxy({ https_proxy: "proxy.corp:8080" })).toEqual([]);
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeDefined();
});

test("an ignored lowercase variable falls back to the uppercase variable", async () => {
  const recorder = await proxy();
  expect(
    initializeEnvironmentProxy(
      {
        https_proxy: "socks5://proxy.invalid",
        HTTPS_PROXY: recorder.url,
      },
      "linux",
    ),
  ).toEqual(["https_proxy"]);
  await expect(
    fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  const socket = new WebSocket("wss://vendor.invalid", {
    agent: webSocketProxyAgent("wss://vendor.invalid"),
  });
  await once(socket, "error");
  expect(recorder.tunnels).toEqual(["vendor.invalid:443", "vendor.invalid:443"]);
});

test("case-insensitive environment access reports a variable only once", () => {
  const env = new Proxy(
    { https_proxy: "socks5://127.0.0.1:7890" },
    {
      get(target, key) {
        return Reflect.get(target, typeof key === "string" ? key.toLowerCase() : key);
      },
    },
  );
  expect(initializeEnvironmentProxy(env)).toEqual(["https_proxy"]);
});

test.each([
  ["wss://remote.invalid/ws", "remote.invalid:443"],
  ["tcp://192.168.1.2:7443?ssl=true", "192.168.1.2:7443"],
])("connected-host links to %s use the legacy environment proxy", async (connection, authority) => {
  const recorder = await proxy();
  initializeEnvironmentProxy({ HTTPS_PROXY: recorder.url });
  const home = await mkdtemp(path.join(os.tmpdir(), "connected-host-proxy-"));
  const hosts = new ConnectedHosts(home, { serverId: "self", label: "Self" });
  try {
    await hosts.add({ connection }, { sourceId: "test", manageSources: true });
    await expect.poll(() => recorder.tunnels).toContain(authority);
  } finally {
    await hosts.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each(["corp.internal,*", "vendor.invalid:0443"])(
  "fetch and WebSockets share NO_PROXY=%s",
  async (noProxy) => {
    const recorder = await proxy();
    initializeEnvironmentProxy({ HTTPS_PROXY: recorder.url, NO_PROXY: noProxy });
    expect(webSocketProxyAgent("wss://vendor.invalid")).toBeUndefined();
    await expect(
      fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    expect(recorder.tunnels).toEqual([]);
  },
);

test("Windows mixed-case environment names route and bypass both transports", async () => {
  const recorder = await proxy();
  // Windows preserves spelling but treats environment names without regard to case.
  initializeEnvironmentProxy({ Https_Proxy: recorder.url, No_Proxy: "other.invalid" }, "win32");
  expect(webSocketProxyAgent("wss://other.invalid")).toBeUndefined();
  await expect(
    fetch("https://other.invalid", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeDefined();
  await expect(
    fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  const socket = new WebSocket("wss://vendor.invalid", {
    agent: webSocketProxyAgent("wss://vendor.invalid"),
  });
  await once(socket, "error");
  expect(recorder.tunnels).toEqual(["vendor.invalid:443", "vendor.invalid:443"]);
});

test("POSIX mixed-case names do not override standard proxy names", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy(
    { Https_Proxy: recorder.url, HTTPS_PROXY: recorder.url, No_Proxy: "*" },
    "linux",
  );
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeDefined();
  await expect(
    fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  expect(recorder.tunnels).toEqual(["vendor.invalid:443"]);
});

test("proxy credentials stay on CONNECT and do not reach the HTTP origin", async () => {
  let originAuthorization: string | undefined;
  const origin = createServer((request, response) => {
    originAuthorization = request.headers["proxy-authorization"];
    response.end("through proxy");
  });
  const originAddress = new URL(`http://${await listen(origin)}`);
  const authorizations: (string | undefined)[] = [];
  const server = createServer();
  server.on("connect", (request, socket, head) => {
    authorizations.push(request.headers["proxy-authorization"]);
    const upstream = connect(Number(originAddress.port), "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  initializeEnvironmentProxy({ HTTP_PROXY: `http://user:@${await listen(server)}` });
  const response = await fetch("http://vendor.invalid", { signal: AbortSignal.timeout(3000) });
  expect(await response.text()).toBe("through proxy");
  expect(authorizations).toEqual([`Basic ${Buffer.from("user:").toString("base64")}`]);
  expect(originAuthorization).toBeUndefined();
});

test.each(["user:@", ":secret@", "user:secret@"])(
  "fetch and WebSockets authenticate proxy credentials %s",
  async (credentials) => {
    const authorizations: (string | undefined)[] = [];
    const server = createServer();
    server.on("connect", (request, socket) => {
      authorizations.push(request.headers["proxy-authorization"]);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    initializeEnvironmentProxy({ HTTPS_PROXY: `http://${credentials}${await listen(server)}` });
    await expect(
      fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    const socket = new WebSocket("wss://vendor.invalid", {
      agent: webSocketProxyAgent("wss://vendor.invalid"),
    });
    await once(socket, "error");
    const expected = `Basic ${Buffer.from(credentials.slice(0, -1)).toString("base64")}`;
    expect(authorizations).toEqual([expected, expected]);
  },
);
