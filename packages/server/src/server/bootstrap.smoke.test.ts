import { resolveDaemonVersion } from "./daemon-version.js";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentClient } from "./agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "./agent/providers/codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./agent/providers/codex/test-utils/fake-app-server.js";
import { PiRpcAgentClient } from "./agent/providers/pi/agent.js";
import {
  JsonlRpcRequestNotSentError,
  JsonlRpcResponseError,
} from "./agent/providers/jsonl-rpc-process.js";
import { FakePi } from "./agent/providers/pi/test-utils/fake-pi.js";
import { OmpAgentClient } from "./agent/providers/omp/agent.js";
import { FakeOmp } from "./agent/providers/omp/test-utils/fake-omp.js";
import http from "node:http";
import path from "node:path";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";

import { createPaseoDaemon, parseListenString, type PaseoDaemonConfig } from "./bootstrap.js";
import { SavedRecoveryTerminalCleanupError } from "./daemon-shutdown-outcome.js";
import { loadConfig } from "./config.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import {
  AgentStorage,
  parseStoredAgentRecord,
  type StoredAgentRecord,
} from "./agent/agent-storage.js";
import { parseAgentMessages } from "./agent/agent-messages/index.js";
import { ensureAgentLoaded } from "./agent/agent-loading.js";
import { AgentManagerShuttingDownError } from "./agent/agent-manager.js";
import { StaleProviderSessionError } from "./agent/stale-provider-session-error.js";
import { hashDaemonPassword } from "./auth.js";
import { generateLocalPairingOffer } from "./pairing-offer.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { isPlatform } from "../test-utils/platform.js";
import { findFreePort } from "./service-proxy.js";
import {
  configureGitProcessPolicy,
  snapshotGitCommandRuntimeMetrics,
} from "../utils/run-git-command.js";
import { DEFAULT_GIT_PROCESS_POLICY } from "../utils/git-process-scheduler.js";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { MessageReceipts } from "./message-receipts/index.js";
import { EXPLICIT_PARENT_REPORTING, PARENT_REPORTING_LABEL } from "@getpaseo/protocol/agent-labels";
import type {
  HubEnrollment,
  HubEnrollmentResult,
  HubRelationshipRemote,
  HubRevocation,
  HubSocketConnection,
  HubSocketCredentials,
  HubSocketEvents,
} from "./hub/relationship-remote.js";

interface HeldAgentClose {
  started: Promise<void>;
  arm(): void;
  closeSession(): Promise<void>;
  finish(): void;
}

interface BlockedDaemonShutdown {
  probeReconnect(): Promise<WebSocketProbeResult>;
  tryCreateAgent(): Promise<"created" | "rejected">;
  finish(): Promise<void>;
}

type WebSocketProbeResult =
  | { status: "connected" }
  | { status: "rejected"; statusCode: number | null };

function localCodexClient(root: string, spawn: () => FakeCodexAppServer) {
  return new CodexAppServerAgentClient(
    pino({ level: "silent" }),
    { command: { mode: "replace", argv: [process.execPath] }, env: { CODEX_HOME: root } },
    {
      appServerProcess: {
        resolvePrefix: async () => ({ command: process.execPath, args: [] }),
        spawn: () => spawn().child,
      },
    },
  );
}

function ignoreError() {}

function hasCodexCompaction(server: FakeCodexAppServer): boolean {
  return server.requests().some(({ method }) => method === "thread/compact/start");
}

function codexTurnCount(server: FakeCodexAppServer): number {
  return server.requests().filter(({ method }) => method === "turn/start").length;
}

function throwRecoverySetupError(error: unknown): never {
  throw error;
}

async function fileExists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

describe("paseo daemon bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("starts and serves health endpoint", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      openai: { stt: { apiKey: "test-openai-api-key" }, tts: { apiKey: "test-openai-api-key" } },
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/health`, {
        headers: daemonHandle.agentMcpAuthHeader
          ? { Authorization: daemonHandle.agentMcpAuthHeader }
          : undefined,
      });
      expect(response.ok).toBe(true);
      const payload = await response.json();
      expect(payload.status).toBe("ok");
      expect(typeof payload.timestamp).toBe("string");
    } finally {
      await daemonHandle.close();
    }
  });

  test("keeps timeline activity in memory and removes obsolete timeline files at startup", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-timeline-cleanup-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const obsoleteTimelineDirectory = path.join(paseoHome, "agent-timelines");
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-timeline-agent-"));
    await mkdir(obsoleteTimelineDirectory, { recursive: true });
    await writeFile(path.join(obsoleteTimelineDirectory, "obsolete.json"), "{}\n", "utf-8");

    const daemonHandle = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
    try {
      await expect(access(obsoleteTimelineDirectory)).rejects.toMatchObject({ code: "ENOENT" });

      const agent = await daemonHandle.daemon.agentManager.createAgent(
        { provider: "codex", cwd: agentCwd },
        undefined,
        { workspaceId: undefined },
      );
      await daemonHandle.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        text: "timeline stays in memory",
      });
      await daemonHandle.daemon.agentManager.flush();

      await expect(access(obsoleteTimelineDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await daemonHandle.close();
      await Promise.all([
        rm(paseoHomeRoot, { recursive: true, force: true }),
        rm(agentCwd, { recursive: true, force: true }),
      ]);
    }
  });

  test("does not create a timeline directory for live timeline activity", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-timeline-memory-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-timeline-agent-"));
    const daemonHandle = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
    const timelineDirectory = path.join(daemonHandle.paseoHome, "agent-timelines");
    try {
      const agent = await daemonHandle.daemon.agentManager.createAgent(
        { provider: "codex", cwd: agentCwd },
        undefined,
        { workspaceId: undefined },
      );
      await daemonHandle.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        text: "timeline stays in memory",
      });
      await daemonHandle.daemon.agentManager.flush();

      await expect(access(timelineDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await daemonHandle.close();
      await Promise.all([
        rm(paseoHomeRoot, { recursive: true, force: true }),
        rm(agentCwd, { recursive: true, force: true }),
      ]);
    }
  });

  test("reload applies live HTTP, MCP, Git, provider, relay, and app policies", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-config-reload-runtime-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-config-reload-agent-"));
    await mkdir(paseoHome, { recursive: true });
    const configPath = path.join(paseoHome, "config.json");
    const initialPersisted = {
      version: 1 as const,
      daemon: {
        listen: "127.0.0.1:0",
        hostnames: ["127.0.0.1", "before.example.test"],
        cors: { allowedOrigins: ["https://before.example.test"] },
        trustedProxies: [],
        mcp: { enabled: true, injectIntoAgents: false },
        git: { maxProcessesPerSecond: 64, maxProcessConcurrency: 8 },
        relay: {
          enabled: false,
          endpoint: "127.0.0.1:9",
          publicEndpoint: "127.0.0.1:9",
          useTls: false,
          publicUseTls: false,
        },
      },
      app: { baseUrl: "https://before.example.test" },
    };
    await writeFile(configPath, `${JSON.stringify(initialPersisted, null, 2)}\n`, "utf-8");
    const config = loadConfig(paseoHome, { env: {} });
    config.staticDir = staticDir;
    config.agentClients = createTestAgentClients();
    config.agentStoragePath = path.join(paseoHome, "agents");
    config.isDev = true;
    config.speech = {
      providers: {
        dictationStt: { provider: "local", explicit: true, enabled: false },
        voiceTurnDetection: { provider: "local", explicit: true, enabled: false },
        voiceStt: { provider: "local", explicit: true, enabled: false },
        voiceTts: { provider: "local", explicit: true, enabled: false },
      },
    };
    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
    let client: DaemonClient | null = null;
    let proxyUpstream: http.Server | null = null;

    try {
      await daemon.start();
      const target = daemon.getListenTarget();
      if (!target || target.type !== "tcp") throw new Error("Expected a TCP listener");
      client = new DaemonClient({
        url: `ws://127.0.0.1:${target.port}/ws`,
        appVersion: "0.4.0",
      });
      await client.connect();

      proxyUpstream = http.createServer((req, res) => {
        res.end(String(req.headers["x-forwarded-proto"] ?? "missing"));
      });
      await new Promise<void>((resolve) => proxyUpstream?.listen(0, "127.0.0.1", resolve));
      const proxyAddress = proxyUpstream.address();
      if (!proxyAddress || typeof proxyAddress === "string") {
        throw new Error("Expected proxy upstream TCP address");
      }
      const proxyRoute = daemon.serviceProxy.registerWorkspaceService({
        workspaceId: "workspace-config-reload",
        projectSlug: "reload",
        branchName: "main",
        scriptName: "proxy",
        port: proxyAddress.port,
      });
      const proxyHost = `${proxyRoute.hostname}:${target.port}`;

      expect(
        (await httpGetWithHost(target.port, "before.example.test", "/api/health")).status,
      ).toBe(200);
      expect((await httpGetWithHost(target.port, "after.example.test", "/api/health")).status).toBe(
        403,
      );
      const beforeCors = await fetch(`http://127.0.0.1:${target.port}/api/health`, {
        headers: { Origin: "https://before.example.test" },
      });
      expect(beforeCors.headers.get("access-control-allow-origin")).toBe(
        "https://before.example.test",
      );
      const beforeMcp = await fetch(`http://127.0.0.1:${target.port}/mcp/agents`, {
        method: "POST",
      });
      expect(beforeMcp.status).toBe(406);
      const beforeProxyReload = await httpGetWithHost(target.port, proxyHost, "/", {
        "x-forwarded-proto": "https",
      });
      expect(await beforeProxyReload.text()).toBe("http");

      const reloadedPersisted = {
        ...initialPersisted,
        daemon: {
          ...initialPersisted.daemon,
          hostnames: ["127.0.0.1", "after.example.test"],
          cors: { allowedOrigins: ["https://after.example.test"] },
          trustedProxies: true as const,
          mcp: { enabled: false, injectIntoAgents: false },
          git: { maxProcessesPerSecond: 5, maxProcessConcurrency: 1 },
          relay: { ...initialPersisted.daemon.relay, enabled: true },
        },
        app: { baseUrl: "https://after.example.test" },
        agents: {
          catalogRefreshTimeoutMs: 5_000,
          providers: { codex: { enabled: false } },
        },
      };
      await writeFile(configPath, `${JSON.stringify(reloadedPersisted, null, 2)}\n`, "utf-8");

      const result = await client.reloadDaemonConfig("runtime-policies");

      expect(result).toEqual({
        requestId: "runtime-policies",
        appliedPaths: [
          "agents.catalogRefreshTimeoutMs",
          "agents.providers",
          "app.baseUrl",
          "daemon.cors.allowedOrigins",
          "daemon.git.maxProcessConcurrency",
          "daemon.git.maxProcessesPerSecond",
          "daemon.hostnames",
          "daemon.mcp.enabled",
          "daemon.relay.enabled",
          "daemon.trustedProxies",
        ],
        restartRequiredPaths: [],
        overrideControlledPaths: [],
      });
      expect(
        (await httpGetWithHost(target.port, "before.example.test", "/api/health")).status,
      ).toBe(403);
      expect((await httpGetWithHost(target.port, "after.example.test", "/api/health")).status).toBe(
        200,
      );
      const afterCors = await fetch(`http://127.0.0.1:${target.port}/api/health`, {
        headers: { Origin: "https://after.example.test" },
      });
      expect(afterCors.headers.get("access-control-allow-origin")).toBe(
        "https://after.example.test",
      );
      const afterProxyReload = await httpGetWithHost(target.port, proxyHost, "/", {
        "x-forwarded-proto": "https",
      });
      expect(await afterProxyReload.text()).toBe("https");
      await expect(
        probeWebSocketConnection(`ws://127.0.0.1:${target.port}/ws`, {
          host: "after.example.test",
          origin: "https://after.example.test",
        }),
      ).resolves.toEqual({ status: "connected" });
      await expect(
        probeWebSocketConnection(`ws://127.0.0.1:${target.port}/ws`, {
          host: "after.example.test",
          origin: "https://before.example.test",
        }),
      ).resolves.toEqual({ status: "rejected", statusCode: 403 });
      expect(
        (
          await fetch(`http://127.0.0.1:${target.port}/mcp/agents`, {
            method: "POST",
          })
        ).status,
      ).toBe(404);
      expect(snapshotGitCommandRuntimeMetrics()).toMatchObject({
        concurrencyLimit: 1,
        maxProcessesPerSecond: 5,
      });
      await expect(
        daemon.agentManager.createAgent({ provider: "codex", cwd: agentCwd }, undefined, {
          workspaceId: undefined,
        }),
      ).rejects.toThrow(/disabled/i);
      expect((await client.getDaemonStatus()).relay?.enabled).toBe(true);
      expect((await client.getDaemonPairingOffer()).url).toContain(
        "https://after.example.test/#offer=",
      );
    } finally {
      configureGitProcessPolicy(DEFAULT_GIT_PROCESS_POLICY);
      await client?.close().catch(() => undefined);
      await daemon.stop().catch(() => undefined);
      if (proxyUpstream) {
        await new Promise<void>((resolve) => proxyUpstream?.close(() => resolve()));
      }
      await Promise.all([
        rm(paseoHomeRoot, { recursive: true, force: true }),
        rm(staticDir, { recursive: true, force: true }),
        rm(agentCwd, { recursive: true, force: true }),
      ]);
    }
  });

  function httpGetWithHost(
    port: number,
    host: string,
    requestPath: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { hostname: "127.0.0.1", port, path: requestPath, headers: { host, ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 0,
                headers: res.headers as HeadersInit,
              }),
            );
          });
        },
      );
      req.on("error", reject);
    });
  }

  test("proxies registered service hosts before daemon auth while daemon APIs stay protected", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("service-ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected upstream TCP address");
    }

    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: hashDaemonPassword("secret") },
    });
    try {
      daemonHandle.daemon.serviceProxy.registerWorkspaceService({
        workspaceId: "workspace-service-auth",
        projectSlug: "repo",
        branchName: "main",
        scriptName: "web",
        port: address.port,
      });

      const serviceResponse = await httpGetWithHost(
        daemonHandle.port,
        `web--repo.localhost:${daemonHandle.port}`,
        "/",
      );
      expect(serviceResponse.status).toBe(200);
      expect(await serviceResponse.text()).toBe("service-ok");

      const daemonResponse = await httpGetWithHost(
        daemonHandle.port,
        `daemon.localhost:${daemonHandle.port}`,
        "/api/status",
      );
      expect(daemonResponse.status).toBe(401);
    } finally {
      await daemonHandle.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("configured public service namespace misses never reach daemon APIs", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      serviceProxy: {
        publicBaseUrl: "https://services.example.com",
        standaloneListen: null,
      },
    });
    try {
      const response = await httpGetWithHost(
        daemonHandle.port,
        `missing.services.example.com:${daemonHandle.port}`,
        "/api/status",
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("404 Not Found");
    } finally {
      await daemonHandle.close();
    }
  });

  test("rolls back daemon listener when standalone service proxy startup fails", async () => {
    const occupiedServer = http.createServer((_req, res) => {
      res.end("occupied");
    });
    await new Promise<void>((resolve) => occupiedServer.listen(0, "127.0.0.1", resolve));
    const address = occupiedServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected occupied TCP address");
    }

    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-standalone-rollback-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    await mkdir(paseoHome, { recursive: true });
    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
      serviceProxy: {
        standaloneListen: `127.0.0.1:${address.port}`,
      },
    };
    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));

    try {
      await expect(daemon.start()).rejects.toThrow();
      await expect(fetch(`http://127.0.0.1:${daemon.port}/api/health`)).rejects.toThrow();
    } finally {
      await daemon.stop().catch(() => undefined);
      await new Promise<void>((resolve) => occupiedServer.close(() => resolve()));
      await rm(paseoHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("local service namespace misses never reach daemon APIs", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: hashDaemonPassword("secret") },
    });
    try {
      const response = await httpGetWithHost(
        daemonHandle.port,
        `missing--repo.localhost:${daemonHandle.port}`,
        "/api/status",
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("404 Not Found");
    } finally {
      await daemonHandle.close();
    }
  });

  test("daemon websocket still upgrades when service proxy upgrade handler is mounted", async () => {
    const daemonHandle = await createTestPaseoDaemon();
    const ws = new WebSocket(`ws://127.0.0.1:${daemonHandle.port}/ws`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
      await daemonHandle.close();
    }
  });

  test("relay config changes during Hub enrollment reach the live runtime", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-relay-startup-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    await mkdir(paseoHome, { recursive: true });
    await writeFile(
      path.join(paseoHome, "hub-relationship.json"),
      `${JSON.stringify({
        version: 1,
        state: "pending",
        relationship: {
          daemonId: "daemon-startup-race",
          idempotencyKey: "enrollment-startup-race",
          hubOrigin: "https://hub.test",
          createdAt: "2026-07-31T00:00:00.000Z",
          scopes: ["hub.execution.*"],
        },
        credential: { secret: "credential" },
        enrollment: { token: "enrollment-token" },
        identity: { serverId: "server-startup-race", daemonPublicKey: "public-key" },
      })}\n`,
      "utf-8",
    );

    let markEnrollmentStarted: () => void = () => undefined;
    const enrollmentStarted = new Promise<void>((resolve) => {
      markEnrollmentStarted = resolve;
    });
    let releaseEnrollment: () => void = () => undefined;
    const enrollmentReleased = new Promise<void>((resolve) => {
      releaseEnrollment = resolve;
    });
    const remote: HubRelationshipRemote = {
      async enroll(input: HubEnrollment): Promise<HubEnrollmentResult> {
        markEnrollmentStarted();
        await enrollmentReleased;
        return {
          daemonId: input.daemonId,
          permissions: input.permissions,
          webSocketUrl: "wss://hub.test/daemon",
        };
      },
      async updatePermissions(input) {
        return { permissions: input.permissions };
      },
      async revoke(_input: HubRevocation): Promise<void> {},
      openSocket(_input: HubSocketCredentials, _events: HubSocketEvents): HubSocketConnection {
        return { close: () => undefined };
      },
    };
    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      relayEndpoint: "127.0.0.1:9",
      relayUseTls: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
    };
    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }), {
      hubRelationshipRemote: remote,
    });
    const starting = daemon.start();
    let client: DaemonClient | null = null;

    try {
      await enrollmentStarted;
      const listenTarget = daemon.getListenTarget();
      if (!listenTarget || listenTarget.type !== "tcp") {
        throw new Error("Expected daemon TCP listener during Hub enrollment");
      }
      client = new DaemonClient({
        url: `ws://127.0.0.1:${listenTarget.port}/ws`,
        appVersion: "0.1.82",
      });
      await client.connect();
      await client.patchDaemonConfig({ relay: { enabled: true } });
      releaseEnrollment();
      await starting;

      const status = await client.getDaemonStatus();
      expect(status.relay?.enabled).toBe(true);
    } finally {
      releaseEnrollment();
      await starting.catch(() => undefined);
      await client?.close().catch(() => undefined);
      await daemon.stop().catch(() => undefined);
      await rm(paseoHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("stops new connections and agent registrations before closing agents", async () => {
    const shutdown = await beginDaemonShutdownWithAgentClosing();
    try {
      await expect(
        Promise.all([shutdown.probeReconnect(), shutdown.tryCreateAgent()]),
      ).resolves.toEqual([{ status: "rejected", statusCode: 503 }, "rejected"]);
    } finally {
      await shutdown.finish();
    }
  });

  test("ordinary shutdown closes terminals and the listener after the admission wait times out", async () => {
    const handle = await createTestPaseoDaemon();
    const { daemon } = handle;
    const waiting = Promise.withResolvers<void>();
    vi.spyOn(daemon.agentManager, "waitForAdmittedRunsToStart").mockImplementationOnce(() => {
      waiting.resolve();
      return new Promise<void>(() => {});
    });
    const closeTerminals = vi.spyOn(daemon.terminalManager, "closeTerminals");
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stopped = daemon.stop();
      const stopAssertion = expect(stopped).resolves.toBeUndefined();
      await waiting.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      vi.useRealTimers();

      await stopAssertion;
      expect(closeTerminals).toHaveBeenCalledOnce();
      await expect(fetch(`http://127.0.0.1:${handle.port}/api/health`)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
      await handle.close();
    }
  });

  test("ordinary shutdown closes terminals and the listener while dispatch is still stuck", async () => {
    const accepting = VoiceAssistantWebSocketServer.prototype.beginAcceptingConnections;
    const socketServer = Promise.withResolvers<VoiceAssistantWebSocketServer>();
    vi.spyOn(
      VoiceAssistantWebSocketServer.prototype,
      "beginAcceptingConnections",
    ).mockImplementationOnce(function (this: VoiceAssistantWebSocketServer) {
      accepting.call(this);
      socketServer.resolve(this);
    });
    const handle = await createTestPaseoDaemon();
    const { daemon } = handle;
    const dispatchStarted = Promise.withResolvers<void>();
    const releaseDispatch = Promise.withResolvers<void>();
    const closeTerminals = vi.spyOn(daemon.terminalManager, "closeTerminals");
    try {
      const agent = await daemon.agentManager.createAgent(
        { provider: "codex", cwd: handle.paseoHome },
        undefined,
        { workspaceId: undefined },
      );
      const { agentMessages } = await socketServer.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const receipt = agentMessages.enqueue({
        recipientId: agent.id,
        prompt: "Queued before shutdown",
        source: { kind: "agent-message", agentId: agent.id },
        async beforeProviderDispatch() {
          dispatchStarted.resolve();
          await releaseDispatch.promise;
        },
      });
      const stopped = daemon.stop();
      const stopAssertion = expect(stopped).resolves.toBeUndefined();
      await dispatchStarted.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      vi.useRealTimers();

      await stopAssertion;
      expect(closeTerminals).toHaveBeenCalledOnce();
      await expect(fetch(`http://127.0.0.1:${handle.port}/api/health`)).rejects.toThrow();
      releaseDispatch.resolve();
      await expect(receipt.dispatched).rejects.toThrow();
    } finally {
      releaseDispatch.resolve();
      vi.useRealTimers();
      await handle.close();
    }
  });

  test("marks a terminal cleanup failure separately only after saving explicit recovery", async () => {
    const handle = await createTestPaseoDaemon();
    const { daemon } = handle;
    const marker = path.join(handle.paseoHome, "restart-recovery-once.json");
    const saveError = new Error("Recovery storage failed");
    const terminalError = new Error("Terminal reaper failed");
    vi.spyOn(daemon.agentStorage, "flush").mockRejectedValueOnce(saveError);
    const closeTerminals = vi
      .spyOn(daemon.terminalManager, "closeTerminals")
      .mockRejectedValueOnce(terminalError);
    try {
      await expect(daemon.stop({ resumeAgents: true })).rejects.toBe(saveError);
      expect(closeTerminals).not.toHaveBeenCalled();
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const stopped = daemon.stop({ resumeAgents: true });
      await expect(stopped).rejects.toBeInstanceOf(SavedRecoveryTerminalCleanupError);
      await expect(stopped).rejects.toHaveProperty("cause", terminalError);
      expect(closeTerminals).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ version: 2, agentIds: [] });
    } finally {
      await handle.close();
    }
  });

  test("ordinary shutdown waits for a non-steerable user turn and dispatches its queued message", async () => {
    const running = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const dispatchEntered = Promise.withResolvers<void>();
    const releaseDispatch = Promise.withResolvers<void>();
    const received: string[] = [];
    const interrupted = vi.fn();
    const clients = createTestAgentClients({
      onInterrupt: interrupted,
      async beforeTurnComplete(prompt) {
        if (prompt !== "Existing work") return;
        running.resolve();
        await finish.promise;
      },
    });
    const codex = clients.codex!;
    const create = codex.createSession.bind(codex);
    vi.spyOn(codex, "createSession").mockImplementation(async (...args) => {
      const session = await create(...args);
      const start = session.startTurn!.bind(session);
      session.startTurn = async (prompt, ...rest) => {
        for (const message of parseAgentMessages(String(prompt)) ?? []) received.push(message.text);
        if (received.length) {
          dispatchEntered.resolve();
          await releaseDispatch.promise;
        }
        return start(prompt, ...rest);
      };
      return session;
    });
    const handle = await createTestPaseoDaemon({ agentClients: clients });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${handle.port}/ws` });
    let stopped: Promise<void> | undefined;
    try {
      await client.connect();
      const agent = await handle.daemon.agentManager.createAgent(
        { provider: "codex", cwd: handle.paseoHome },
        undefined,
        { workspaceId: undefined },
      );
      const original = handle.daemon.agentManager.runAgent(agent.id, "Existing work");
      void original.catch(() => undefined);
      await running.promise;
      const texts = ["First queued message", "Second queued message"];
      for (const text of texts) {
        await expect(
          client.sendAgentMessage(agent.id, text, {
            sourceAgentId: agent.id,
            messageId: text,
          }),
        ).resolves.toEqual({ deliveryStatus: "queued" });
      }

      const receipts = path.join(handle.paseoHome, "agent-requests");
      const files = await readdir(receipts);
      expect(files).toHaveLength(texts.length);
      const readReceipts = () =>
        Promise.all(
          files.map(async (file) => JSON.parse(await readFile(path.join(receipts, file), "utf8"))),
        );
      stopped = handle.daemon.stop();
      void stopped.catch(() => undefined);
      // Leave the original turn running while shutdown begins to drain.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(interrupted).not.toHaveBeenCalled();
      expect(received).toEqual([]);
      finish.resolve();
      await expect(original).resolves.toMatchObject({ canceled: false });
      await dispatchEntered.promise;
      expect(await readReceipts()).toMatchObject(texts.map(() => ({ state: "pending" })));
      releaseDispatch.resolve();
      await stopped;
      expect(received).toEqual(texts);
      expect(await readReceipts()).toMatchObject(texts.map(() => ({ state: "completed" })));
    } finally {
      finish.resolve();
      releaseDispatch.resolve();
      await stopped?.catch(() => undefined);
      await client.close();
      await handle.close();
    }
  });

  test("ordinary shutdown can deliver to a healthy steerable turn beyond the drain budget", async () => {
    const running = Promise.withResolvers<void>();
    const providerAccepted = Promise.withResolvers<void>();
    const steered = vi.fn(async () => {
      providerAccepted.resolve();
      return { status: "accepted" as const };
    });
    const handle = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        steerActiveTurn: steered,
        async beforeTurnComplete() {
          const finish = new Promise((resolve) => setTimeout(resolve, 5_100));
          running.resolve();
          await finish;
        },
      }),
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${handle.port}/ws` });
    let stopped: Promise<void> | undefined;
    try {
      await client.connect();
      const agent = await handle.daemon.agentManager.createAgent(
        { provider: "codex", cwd: handle.paseoHome },
        undefined,
        { workspaceId: undefined },
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const run = handle.daemon.agentManager.runAgent(agent.id, "Healthy long-running work");
      void run.catch(() => undefined);
      await running.promise;
      await expect(
        client.sendAgentMessage(agent.id, "Queued work for a live provider", {
          sourceAgentId: agent.id,
          messageId: "queued-at-timeout",
        }),
      ).resolves.toEqual({ deliveryStatus: "queued" });
      stopped = handle.daemon.stop();
      void stopped.catch(() => undefined);
      await providerAccepted.promise;
      await stopped;
      await vi.advanceTimersByTimeAsync(5_100);
      const receipts = path.join(handle.paseoHome, "agent-requests");
      const [file] = await readdir(receipts);
      const disk = JSON.parse(await readFile(path.join(receipts, file!), "utf8"));
      expect({
        steers: steered.mock.calls.length,
        receipt: disk.state,
      }).toEqual({ steers: 1, receipt: "completed" });
    } finally {
      vi.useRealTimers();
      await stopped?.catch(() => undefined);
      await client.close();
      await handle.close();
    }
  });

  test("ordinary shutdown replays a queued Codex turn claimed before shutdown but never sent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-claimed-queue-"));
    const release = Promise.withResolvers<void>();
    const preparing = Promise.withResolvers<void>();
    const admissionPaused = Promise.withResolvers<void>();
    let holdNextLoad = false;
    const firstServers: FakeCodexAppServer[] = [];
    const replayServers: FakeCodexAppServer[] = [];
    const makeFirstServer = () =>
      createFakeCodexAppServer({
        "thread/loaded/list": async () => {
          if (holdNextLoad) {
            holdNextLoad = false;
            preparing.resolve();
            await release.promise;
          }
          return { data: ["thread-1"] };
        },
      });
    const replayed: string[] = [];
    const makeReplayServer = () =>
      createFakeCodexAppServer({
        "turn/start": (params) => {
          const input = (params as { input: Array<{ type: string; text?: string }> }).input;
          for (const part of input) {
            if (part.type === "text") {
              for (const message of parseAgentMessages(part.text ?? "") ?? []) {
                replayed.push(message.text);
              }
            }
          }
          return {};
        },
      });

    const handles: Awaited<ReturnType<typeof createTestPaseoDaemon>>[] = [];
    const clients: DaemonClient[] = [];
    async function open(makeServer: () => FakeCodexAppServer, servers: FakeCodexAppServer[]) {
      const handle = await createTestPaseoDaemon({
        paseoHomeRoot: root,
        staticDir: root,
        cleanup: false,
        resumeOnStartup: false,
        agentClients: {
          codex: localCodexClient(root, () => {
            const server = makeServer();
            servers.push(server);
            return server;
          }),
        },
      });
      handles.push(handle);
      const client = new DaemonClient({ url: "ws://127.0.0.1:" + handle.port + "/ws" });
      clients.push(client);
      await client.connect();
      return { ...handle, client };
    }
    const submitted: Promise<unknown>[] = [];
    const sendQueued = MessageReceipts.prototype.sendQueued;
    const trackSends = vi
      .spyOn(MessageReceipts.prototype, "sendQueued")
      .mockImplementation(function (this: MessageReceipts, input) {
        const sent = sendQueued.call(this, input);
        submitted.push(sent);
        void sent.catch(ignoreError);
        return sent;
      });
    let stopping: Promise<void> | undefined;
    try {
      const first = await open(makeFirstServer, firstServers);
      const manager = first.daemon.agentManager;
      const agent = await manager.createAgent({ provider: "codex", cwd: root }, undefined, {
        workspaceId: undefined,
      });
      const original = manager.runAgent(agent.id, "Establish a saved thread");
      void original.catch(() => undefined);
      await expect.poll(() => firstServers.some(codexTurnCount)).toBe(true);
      const firstServer = firstServers.find(codexTurnCount)!;
      firstServer.startsTurn({ threadId: "thread-1", turnId: "initial-turn" });
      firstServer.completeTurn({ threadId: "thread-1" });
      await original;

      holdNextLoad = true;
      const expected = ["first queued prompt", "second queued prompt"];
      for (const prompt of expected) {
        await expect(
          first.client.sendAgentMessage(agent.id, prompt, {
            sourceAgentId: agent.id,
            messageId: prompt,
          }),
        ).resolves.toEqual({ deliveryStatus: "queued" });
      }
      await preparing.promise;
      const pause = manager.pauseRunAdmission.bind(manager);
      vi.spyOn(manager, "pauseRunAdmission").mockImplementation(() => {
        const undoPause = pause();
        admissionPaused.resolve();
        return undoPause;
      });
      const persisted = new MessageReceipts(path.join(first.paseoHome, "agent-requests"));
      // Let the claimed run reach the real handoff after the drain budget, before session teardown.
      const close = manager.closeAgent.bind(manager);
      const closing = vi.spyOn(manager, "closeAgent").mockImplementation(async (...args) => {
        await Promise.allSettled(submitted);
        await close(...args);
      });
      stopping = first.daemon.stop();
      await admissionPaused.promise;
      release.resolve();
      await stopping;
      closing.mockRestore();
      trackSends.mockRestore();
      expect(firstServers.map(codexTurnCount).reduce((a, b) => a + b, 0)).toBe(1);
      expect((await persisted.queuedMessages()).map(({ queued }) => queued.message.prompt)).toEqual(
        expected,
      );

      const second = await open(makeReplayServer, replayServers);
      await expect.poll(() => replayed[0], { timeout: 8_000 }).toBe(expected[0]);
      const server = replayServers.find(codexTurnCount)!;
      server.startsTurn({ threadId: "thread-1", turnId: "replayed-first" });
      server.completeTurn({ threadId: "thread-1" });
      await expect.poll(() => replayed, { timeout: 8_000 }).toEqual(expected);
      if (codexTurnCount(server) > 1) {
        server.startsTurn({ threadId: "thread-1", turnId: "replayed-second" });
        server.completeTurn({ threadId: "thread-1" });
      }
      await expect.poll(() => persisted.queuedMessages()).toEqual([]);
      for (const prompt of expected) {
        await second.client.sendAgentMessage(agent.id, prompt, {
          sourceAgentId: agent.id,
          messageId: prompt,
        });
      }
      expect(replayed).toEqual(expected);
      firstServer.assertNoErrors();
      server.assertNoErrors();
    } finally {
      release.resolve();
      await stopping?.catch(() => undefined);
      for (const client of clients) await client.close();
      for (const handle of handles.toReversed()) await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ordinary shutdown restores non-steerable queued messages in order before new ingress", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-queue-recovery-"));
    const running = Promise.withResolvers<void>();
    const received: string[] = [];
    const handles: Awaited<ReturnType<typeof createTestPaseoDaemon>>[] = [];
    const clients: DaemonClient[] = [];
    const open = async (agentClients: ReturnType<typeof createTestAgentClients>) => {
      const handle = await createTestPaseoDaemon({
        paseoHomeRoot: root,
        cleanup: false,
        resumeOnStartup: false,
        agentClients,
      });
      handles.push(handle);
      const client = new DaemonClient({ url: `ws://127.0.0.1:${handle.port}/ws` });
      clients.push(client);
      await client.connect();
      return { ...handle, client };
    };
    try {
      const first = await open(
        createTestAgentClients({
          async beforeTurnComplete() {
            const finish = new Promise((resolve) => setTimeout(resolve, 5_100));
            running.resolve();
            await finish;
          },
        }),
      );
      const agent = await first.daemon.agentManager.createAgent(
        { provider: "codex", cwd: root },
        undefined,
        { workspaceId: undefined },
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const original = first.daemon.agentManager.runAgent(agent.id, "Healthy existing work");
      void original.catch(() => undefined);
      await running.promise;
      for (const text of ["first", "second"]) {
        await expect(
          first.client.sendAgentMessage(agent.id, text, {
            sourceAgentId: agent.id,
            messageId: text,
          }),
        ).resolves.toEqual({ deliveryStatus: "queued" });
      }
      const stopped = first.daemon.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      await stopped;
      await vi.advanceTimersByTimeAsync(100);
      vi.useRealTimers();
      const directory = path.join(first.paseoHome, "agent-requests");
      const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
      const readReceipts = () =>
        Promise.all(
          files.map(async (file) => JSON.parse(await readFile(path.join(directory, file), "utf8"))),
        );
      expect(files).toHaveLength(2);
      for (const record of await readReceipts()) {
        expect(record).toMatchObject({
          state: "pending",
          queued: { message: { source: { agentId: agent.id } } },
        });
      }

      const second = await open(
        createTestAgentClients({
          onStartTurn(prompt) {
            for (const message of parseAgentMessages(String(prompt)) ?? [])
              received.push(message.text);
          },
        }),
      );
      await expect(
        second.client.sendAgentMessage(agent.id, "third", {
          sourceAgentId: agent.id,
          messageId: "third",
        }),
      ).resolves.toEqual({ deliveryStatus: "queued" });
      await second.daemon.stop();
      expect(received).toEqual(["first", "second", "third"]);
      for (const record of await readReceipts()) {
        expect(record.state).toBe("completed");
        expect(record.queued).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
      for (const client of clients) await client.close();
      for (const handle of handles.toReversed()) {
        await handle.close();
        await rm(handle.staticDir, { recursive: true, force: true });
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["signal", "restart", "shutdown"] as const)(
    "ordinary %s captures a running turn while deferring durable queued messages",
    async (entry) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-ordinary-recovery-"));
      const running = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const onLifecycleIntent = vi.fn();
      const home = path.join(root, ".paseo");
      const config: PaseoDaemonConfig = {
        ...loadConfig(home, { env: {} }),
        listen: "127.0.0.1:0",
        staticDir: root,
        agentStoragePath: path.join(home, "agents"),
        agentClients: createTestAgentClients({
          async beforeTurnComplete() {
            running.resolve();
            await release.promise;
          },
        }),
        mcpEnabled: false,
        relayEnabled: false,
        pluginsEnabled: false,
        resumeOnStartup: true,
        onLifecycleIntent,
      };
      const first = await createPaseoDaemon(config, pino({ level: "silent" }));
      let second: typeof first | undefined;
      let client: DaemonClient | undefined;
      try {
        await first.start();
        const listen = first.getListenTarget();
        if (listen?.type !== "tcp") throw new Error("Expected an isolated TCP listener");
        client = new DaemonClient({ url: `ws://127.0.0.1:${listen.port}/ws` });
        await client.connect();
        const agent = await first.agentManager.createAgent(
          { provider: "codex", cwd: root },
          undefined,
          { workspaceId: undefined },
        );
        void first.agentManager.runAgent(agent.id, "Existing non-steerable work").catch(() => {});
        await running.promise;
        await first.agentStorage.flush();
        for (const text of ["first durable", "second durable"]) {
          await expect(
            client.sendAgentMessage(agent.id, text, {
              sourceAgentId: agent.id,
              messageId: text,
            }),
          ).resolves.toEqual({ deliveryStatus: "queued" });
        }
        if (entry === "signal") {
          await first.stop();
          expect(onLifecycleIntent).not.toHaveBeenCalled();
        } else {
          const request =
            entry === "restart"
              ? client.restartServer(undefined, undefined, { timeout: 12_000 })
              : client.shutdownServer({ timeout: 12_000 });
          await expect(request).resolves.toMatchObject({ status: `${entry}_requested` });
          expect(onLifecycleIntent).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              type: entry,
              resumeAgents: false,
            }),
          );
          await first.stop();
        }
        const reopenedStorage = new AgentStorage(
          path.join(home, "agents"),
          pino({ level: "silent" }),
        );
        const stored = await reopenedStorage.get(agent.id);
        expect(stored?.resumeOnStartup).toBe(true);
        const receipts = new MessageReceipts(path.join(home, "agent-requests"));
        expect(
          (await receipts.queuedMessages()).map(({ queued }) => queued.message.messageId),
        ).toEqual(["first durable", "second durable"]);
        const prompts: string[] = [];
        second = await createPaseoDaemon(
          {
            ...config,
            agentClients: createTestAgentClients({
              onStartTurn(prompt) {
                const messages = parseAgentMessages(String(prompt));
                if (messages) prompts.push(...messages.map(({ text }) => text));
                else prompts.push(String(prompt));
              },
            }),
          },
          pino({ level: "silent" }),
        );
        await second.start();
        await expect
          .poll(() => prompts, { timeout: 7_000 })
          .toEqual(["Resume working.", "first durable", "second durable"]);
        await expect.poll(() => receipts.queuedMessages()).toEqual([]);
      } finally {
        release.resolve();
        await client?.close();
        await second?.stop();
        await first.stop().catch(() => {});
        await rm(root, { force: true, recursive: true });
      }
    },
    25_000,
  );

  test("startup rechecks the saved direct parent and recipient archive state before replay", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-queue-recovery-policy-"));
    const handles: Awaited<ReturnType<typeof createTestPaseoDaemon>>[] = [];
    const open = async (agentClients: ReturnType<typeof createTestAgentClients>) => {
      const handle = await createTestPaseoDaemon({
        paseoHomeRoot: root,
        cleanup: false,
        resumeOnStartup: false,
        agentClients,
      });
      handles.push(handle);
      return handle;
    };
    try {
      const first = await open(createTestAgentClients());
      const parent = { agentId: randomUUID(), serverId: "original-parent-host" };
      const receipts = new MessageReceipts(path.join(first.paseoHome, "agent-requests"));
      const targets = [];
      for (const text of ["valid parent", "changed parent", "archived recipient"]) {
        const target = await first.daemon.agentManager.createAgent(
          { provider: "codex", cwd: root },
          undefined,
          {
            workspaceId: undefined,
            labels: {
              "paseo.parent-agent-id": parent.agentId,
              "paseo.parent-server-id": parent.serverId,
            },
          },
        );
        targets.push(target.id);
        const admitted = Promise.withResolvers<void>();
        void receipts
          .sendQueued({
            agentId: target.id,
            request: { text },
            message: {
              messageId: randomUUID(),
              prompt: text,
              source: parent,
              directParent: parent,
              activeTurnBehavior: "steer",
              unarchive: false,
            },
            enqueue: async () => ({ dispatched: new Promise(() => {}) }),
            onQueued: admitted.resolve,
          })
          .catch(admitted.reject);
        await admitted.promise;
      }
      await first.daemon.stop();

      const storage = new AgentStorage(
        path.join(first.paseoHome, "agents"),
        pino({ level: "silent" }),
      );
      const changed = (await storage.get(targets[1]!))!;
      await storage.upsert({
        ...changed,
        labels: { ...changed.labels, "paseo.parent-server-id": "new-parent-host" },
      });
      const archived = (await storage.get(targets[2]!))!;
      await storage.upsert({ ...archived, archivedAt: new Date().toISOString() });

      const received: unknown[] = [];
      const restarted = await open(
        createTestAgentClients({
          onStartTurn(prompt) {
            for (const message of parseAgentMessages(String(prompt)) ?? []) {
              received.push({ text: message.text, source: message.source });
            }
          },
        }),
      );
      await restarted.daemon.stop();
      expect(received).toEqual([
        { text: "valid parent", source: { kind: "agent-message", ...parent } },
      ]);
      expect(await receipts.queuedMessages()).toEqual([]);
      expect((await restarted.daemon.agentStorage.get(archived.id))?.archivedAt).toBeTruthy();
    } finally {
      for (const handle of handles.toReversed()) {
        await handle.close();
        await rm(handle.staticDir, { recursive: true, force: true });
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ordinary shutdown restores same-host MCP prompts once, in order, and rechecks parent authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-mcp-queue-recovery-"));
    const running = Promise.withResolvers<void>();
    let busyTurns = 0;
    const received: unknown[] = [];
    const notifications: unknown[] = [];
    const lastTask = "Second task. Respond with exactly: recovered-finish-result";
    const handles: Awaited<ReturnType<typeof createTestPaseoDaemon>>[] = [];
    const open = async (agentClients: ReturnType<typeof createTestAgentClients>) => {
      const handle = await createTestPaseoDaemon({
        paseoHomeRoot: root,
        cleanup: false,
        resumeOnStartup: false,
        agentClients,
      });
      handles.push(handle);
      return handle;
    };
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const mcp = new Client({ name: "mcp-queue-test", version: "1" });
    try {
      const first = await open(
        createTestAgentClients({
          async beforeTurnComplete() {
            const finish = new Promise((resolve) => setTimeout(resolve, 5_100));
            if (++busyTurns === 2) running.resolve();
            await finish;
          },
        }),
      );
      const manager = first.daemon.agentManager;
      const parent = await manager.createAgent({ provider: "codex", cwd: root }, undefined, {
        workspaceId: undefined,
      });
      const createChild = (labels?: Record<string, string>) =>
        manager.createAgent({ provider: "codex", cwd: root }, undefined, {
          workspaceId: undefined,
          labels: { ...labels, "paseo.parent-agent-id": parent.id },
        });
      const child = await createChild();
      const moved = await createChild({ [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING });
      await mcp.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${first.port}/mcp/agents?callerAgentId=${parent.id}`),
        ),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      for (const target of [child, moved]) {
        void manager.runAgent(target.id, "Healthy current work").catch(() => undefined);
      }
      await running.promise;
      const directory = path.join(first.paseoHome, "agent-requests");
      const expectedById = new Map<string, string>();
      for (const [target, text] of [
        [child, "first task"],
        [moved, "expired task"],
        [child, lastTask],
      ] as const) {
        const accepted = await mcp.callTool({
          name: "send_agent_prompt",
          arguments: {
            agentId: target.id,
            prompt: text,
            ...(text === "first task" ? { notifyOnFinish: false } : {}),
          },
        });
        expect(accepted.structuredContent).toMatchObject({
          success: true,
          deliveryStatus: "queued",
          messageId: expect.any(String),
        });
        expectedById.set(String(accepted.structuredContent?.messageId), text);
      }
      const queued = await new MessageReceipts(directory).queuedMessages();
      expect(queued.map(({ queued: { message } }) => expectedById.get(message.messageId))).toEqual([
        "first task",
        "expired task",
        lastTask,
      ]);
      expect(queued.map(({ queued: { message } }) => message.directParent)).toEqual(
        Array.from({ length: 3 }, () => ({
          agentId: parent.id,
          serverId: first.daemon.getServerId(),
        })),
      );
      expect(queued.map(({ queued: { message } }) => message.notifyLocalCaller)).toEqual([
        false,
        false,
        true,
      ]);
      await mcp.close();
      const stopped = first.daemon.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      await stopped;
      await vi.advanceTimersByTimeAsync(100);
      vi.useRealTimers();
      const storage = new AgentStorage(
        path.join(first.paseoHome, "agents"),
        pino({ level: "silent" }),
      );
      const changed = (await storage.get(moved.id))!;
      await storage.upsert({
        ...changed,
        labels: { ...changed.labels, "paseo.parent-agent-id": randomUUID() },
      });
      const capture = () =>
        createTestAgentClients({
          onStartTurn(prompt) {
            for (const message of parseAgentMessages(String(prompt)) ?? []) {
              if (message.source?.kind === "agent-notification") notifications.push(message);
              else received.push({ text: message.text, source: message.source });
            }
          },
        });
      const second = await open(capture());
      await vi.waitFor(() => expect(notifications).not.toHaveLength(0), { timeout: 7_000 });
      await second.daemon.stop();
      const records = await Promise.all(
        (await readdir(directory)).map(async (file) =>
          JSON.parse(await readFile(path.join(directory, file), "utf8")),
        ),
      );
      expect(records).toMatchObject([{ state: "completed" }, { state: "completed" }]);
      const third = await open(capture());
      await third.daemon.stop();
      expect(notifications).toMatchObject([
        {
          source: { kind: "agent-notification", agentId: child.id, event: "finished" },
          text: expect.stringContaining("recovered-finish-result"),
        },
      ]);
      expect(received).toEqual(
        ["first task", lastTask].map((text) => ({
          text,
          source: {
            kind: "agent-message",
            agentId: parent.id,
            serverId: first.daemon.getServerId(),
          },
        })),
      );
    } finally {
      vi.useRealTimers();
      await mcp.close();
      for (const handle of handles.toReversed()) {
        await handle.close();
        await rm(handle.staticDir, { recursive: true, force: true });
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("explicit shutdown reopens delivery if an admitted dispatch does not finish in time", async () => {
    const accepting = VoiceAssistantWebSocketServer.prototype.beginAcceptingConnections;
    const socketServer = Promise.withResolvers<VoiceAssistantWebSocketServer>();
    vi.spyOn(
      VoiceAssistantWebSocketServer.prototype,
      "beginAcceptingConnections",
    ).mockImplementationOnce(function (this: VoiceAssistantWebSocketServer) {
      accepting.call(this);
      socketServer.resolve(this);
    });
    const providerStarts: string[] = [];
    const handle = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        onStartTurn(prompt) {
          for (const message of parseAgentMessages(String(prompt)) ?? []) {
            providerStarts.push(message.text);
          }
        },
      }),
    });
    const dispatchEntered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const client = new DaemonClient({ url: `ws://127.0.0.1:${handle.port}/ws` });
    try {
      await client.connect();
      const agent = await handle.daemon.agentManager.createAgent(
        { provider: "codex", cwd: handle.paseoHome },
        undefined,
        { workspaceId: undefined },
      );
      const { agentMessages } = await socketServer.promise;
      const message = {
        recipientId: agent.id,
        prompt: "Queued work",
        source: { kind: "agent-message" as const, agentId: agent.id },
      };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const original = agentMessages.enqueue({
        ...message,
        async beforeProviderDispatch() {
          dispatchEntered.resolve();
          await finish.promise;
        },
      });
      const preparing = expect(handle.daemon.stop({ resumeAgents: true })).rejects.toThrow(
        "dispatch queued agent messages",
      );
      await dispatchEntered.promise;
      expect(() => agentMessages.enqueue(message)).toThrow("preparing for shutdown");
      await vi.advanceTimersByTimeAsync(5_000);
      await preparing;
      vi.useRealTimers();
      await expect(
        client.sendAgentMessage(agent.id, "Work after failed stop", {
          sourceAgentId: agent.id,
          messageId: "after-failed-stop",
        }),
      ).resolves.toEqual({ deliveryStatus: "queued" });
      const receipts = path.join(handle.paseoHome, "agent-requests");
      const [file] = await readdir(receipts);
      const receiptPath = path.join(receipts, file!);
      expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({ state: "pending" });
      finish.resolve();
      await expect(original.dispatched).resolves.toBe("turn_started");
      await handle.daemon.stop();
      expect(providerStarts).toEqual(["Queued work", "Work after failed stop"]);
      expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({ state: "completed" });
    } finally {
      finish.resolve();
      vi.useRealTimers();
      await client.close();
      await handle.close();
    }
  });

  test.each([
    { provider: "pi", mode: "automatic", outcome: "accepted" },
    { provider: "pi", mode: "automatic", outcome: "rejected" },
    { provider: "pi", mode: "automatic", outcome: "unknown" },
    { provider: "pi", mode: "automatic", outcome: "unsent" },
    { provider: "omp", mode: "automatic", outcome: "accepted" },
    { provider: "omp", mode: "automatic", outcome: "rejected" },
    { provider: "omp", mode: "automatic", outcome: "unknown" },
    { provider: "omp", mode: "automatic", outcome: "unsent" },
    { provider: "codex", mode: "once", outcome: "accepted" },
    { provider: "codex", mode: "once", outcome: "rejected" },
    { provider: "codex", mode: "once", outcome: "unknown" },
  ] as const)(
    "$provider $mode recovery of /compact waits for an $outcome provider outcome",
    async ({ provider, mode, outcome }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-recovery-compact-"));
      const paseoHome = path.join(root, ".paseo");
      const marker = path.join(
        paseoHome,
        mode === "once" ? "restart-recovery-once.json" : "restart-recovery-pending.json",
      );
      const agentId = randomUUID();
      const timestamp = new Date().toISOString();
      const seed = new AgentStorage(path.join(paseoHome, "agents"), pino({ level: "silent" }));
      const providerEntered = Promise.withResolvers<void>();
      const respond = Promise.withResolvers<void>();
      const requests: string[] = [];
      let retrying = false;
      const retryOnRestart = outcome === "rejected" || outcome === "unsent";
      const nativeHandle = path.join(root, "provider-session.jsonl");
      const codex = () =>
        createFakeCodexAppServer({
          "thread/compact/start": async () => {
            requests.push("/compact");
            providerEntered.resolve();
            await respond.promise;
            if (!retrying && outcome === "rejected") {
              return { __jsonRpcError: { code: -32602, message: "Compaction not available" } };
            }
            if (outcome === "unknown") {
              return { __jsonRpcError: { code: -32603, message: "Outcome unknown" } };
            }
            return {};
          },
        });
      const codexServers: FakeCodexAppServer[] = [];
      const createCodex = () => {
        const server = codex();
        codexServers.push(server);
        return server;
      };
      const respondLocally = async () => {
        requests.push("/compact");
        providerEntered.resolve();
        await respond.promise;
        if (!retrying && outcome === "rejected") {
          throw new JsonlRpcResponseError("Compaction not available");
        }
        if (!retrying && outcome === "unsent") {
          throw new JsonlRpcRequestNotSentError("Provider stdin is not writable");
        }
        if (outcome === "unknown") {
          throw new Error("Provider process exited before replying");
        }
      };
      const failed = Promise.withResolvers<unknown>();
      let recoveryError: unknown;
      const logger = pino({ level: "silent" });
      const childLogger = logger.child({ module: "bootstrap" });
      vi.spyOn(logger, "child").mockReturnValueOnce(childLogger);
      vi.spyOn(childLogger, "error").mockImplementation((fields, message) => {
        if (message === "Agent restart recovery failed") {
          recoveryError = (fields as { err?: unknown }).err;
          failed.resolve(recoveryError);
        }
      });
      let handle: Awaited<ReturnType<typeof createTestPaseoDaemon>> | undefined;
      const openDaemon = () => {
        const pi = new FakePi();
        const omp = new FakeOmp();
        // The runtime boundary is controlled, while session restore and command handling are real.
        for (let i = 0; i < 2; i++) {
          pi.queueSessionSetup((session) => {
            session.compact = respondLocally;
          });
          omp.queueSessionSetup((session) => {
            session.compact = respondLocally;
          });
        }
        const adapterLogger = pino({ level: "silent" });
        const runtimeSettings = { command: { mode: "replace" as const, argv: [process.execPath] } };
        const adapters = {
          codex: localCodexClient(root, createCodex),
          pi: new PiRpcAgentClient({ logger: adapterLogger, runtimeSettings, runtime: pi }),
          omp: new OmpAgentClient({ logger: adapterLogger, runtimeSettings, runtime: omp }),
        };
        const agentClients = { [provider]: adapters[provider] };
        return createTestPaseoDaemon({
          paseoHomeRoot: root,
          staticDir: root,
          cleanup: false,
          mcpEnabled: false,
          resumeOnStartup: mode === "automatic",
          resumePrompt: "/compact",
          agentClients,
          logger,
        });
      };
      try {
        await writeFile(
          nativeHandle,
          JSON.stringify({ type: "session", version: 3, id: "thread-1", cwd: root, timestamp }) +
            "\n",
        );
        await seed.upsert(
          parseStoredAgentRecord({
            id: agentId,
            provider,
            cwd: root,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastStatus: "closed",
            resumeOnStartup: true,
            persistence: {
              provider,
              sessionId: "thread-1",
              ...(provider === "codex" ? {} : { nativeHandle }),
            },
          }),
        );
        await seed.flush();
        await writeFile(marker, JSON.stringify({ version: 2, agentIds: [agentId] }));
        handle = await openDaemon();
        await Promise.race([providerEntered.promise, failed.promise.then(throwRecoverySetupError)]);
        await expect(handle.daemon.stop({ resumeAgents: true })).rejects.toThrow(
          "startup recovery is still in progress",
        );
        await expect(access(marker)).resolves.toBeUndefined();
        respond.resolve();
        if (retryOnRestart) {
          await expect.poll(() => recoveryError).toBeInstanceOf(Error);
          await expect(access(marker)).resolves.toBeUndefined();
        } else {
          await expect.poll(() => fileExists(marker)).toBe(false);
        }
        expect(requests).toEqual(["/compact"]);
        await handle.close();
        retrying = true;
        handle = await openDaemon();
        if (retryOnRestart) {
          await expect.poll(() => requests).toEqual(["/compact", "/compact"]);
          await expect.poll(() => fileExists(marker)).toBe(false);
        }
        await expect
          .poll(async () => (await handle!.daemon.agentStorage.get(agentId))?.resumeOnStartup)
          .toBe(false);
        await expect(handle.daemon.stop({ resumeAgents: true })).resolves.toBeUndefined();
        expect(requests).toHaveLength(retryOnRestart ? 2 : 1);
        for (const commandServer of codexServers.filter(hasCodexCompaction)) {
          commandServer.assertNoErrors();
        }
      } finally {
        respond.resolve();
        await handle?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["rejected", "late-start", "late-rejection"] as const)(
    "startup recovery confirms provider outcome %s before consuming its record",
    async (outcome) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-confirm-recovery-"));
      const paseoHome = path.join(root, ".paseo");
      const marker = path.join(paseoHome, "restart-recovery-once.json");
      const agentId = randomUUID();
      const seed = new AgentStorage(path.join(paseoHome, "agents"), pino({ level: "silent" }));
      const timestamp = new Date().toISOString();
      const providerEntered = Promise.withResolvers<void>();
      const providerOutcome = Promise.withResolvers<void>();
      let recoveryErrorReported = false;
      const unconfirmed = Promise.withResolvers<void>();
      const logger = pino({ level: "silent" });
      const bootstrapLogger = logger.child({ module: "bootstrap" });
      vi.spyOn(logger, "child").mockReturnValueOnce(bootstrapLogger);
      vi.spyOn(bootstrapLogger, "error").mockImplementation((_error, message) => {
        if (message === "Agent restart recovery failed") recoveryErrorReported = true;
      });
      vi.spyOn(bootstrapLogger, "warn").mockImplementation((_error, message) => {
        if (message === "Agent restart recovery start is unconfirmed") unconfirmed.resolve();
      });
      const clients = createTestAgentClients();
      const codex = clients.codex!;
      const resume = codex.resumeSession.bind(codex);
      const startTurn = vi.fn();
      vi.spyOn(codex, "resumeSession").mockImplementation(async (...args) => {
        const session = await resume(...args);
        const start = session.startTurn?.bind(session);
        if (!start) throw new Error("Test session must support starting a turn");
        session.startTurn = async (...turnArgs) => {
          startTurn(...turnArgs);
          providerEntered.resolve();
          await providerOutcome.promise;
          return start(...turnArgs);
        };
        return session;
      });
      const handles: Awaited<ReturnType<typeof createTestPaseoDaemon>>[] = [];
      async function launch(agentClients = clients, daemonLogger = logger) {
        const handle = await createTestPaseoDaemon({
          paseoHomeRoot: root,
          cleanup: false,
          resumeOnStartup: false,
          agentClients,
          logger: daemonLogger,
        });
        handles.push(handle);
        return handle;
      }
      try {
        await seed.upsert(
          parseStoredAgentRecord({
            id: agentId,
            provider: "codex",
            cwd: root,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastStatus: "closed",
            resumeOnStartup: true,
            persistence: { provider: "codex", sessionId: "previous-session" },
          }),
        );
        await seed.flush();
        await writeFile(marker, JSON.stringify({ version: 2, agentIds: [agentId] }));
        if (outcome !== "rejected") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const first = await launch();
        await providerEntered.promise;
        expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
          version: 2,
          agentIds: [agentId],
        });
        const accepted = vi.fn();
        const nextClients = createTestAgentClients({ onStartTurn: accepted });
        if (outcome !== "rejected") {
          await vi.advanceTimersByTimeAsync(60_000);
          await unconfirmed.promise;
          expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
            version: 2,
            agentIds: [agentId],
          });
          await expect(first.daemon.stop({ resumeAgents: true })).rejects.toThrow(
            "startup recovery is still in progress",
          );
          vi.useRealTimers();
        }
        if (outcome === "late-start") {
          providerOutcome.resolve();
          await vi.waitFor(() =>
            expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" }),
          );
          await first.daemon.stop();
        } else {
          providerOutcome.reject(new Error("Test provider rejected this turn"));
          await vi.waitFor(() => expect(recoveryErrorReported).toBe(true));
          await first.daemon.stop();
          expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
            version: 2,
            agentIds: [agentId],
          });
          const second = await launch(nextClients, pino({ level: "silent" }));
          await vi.waitFor(async () => {
            await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
            expect(await second.daemon.agentStorage.get(agentId)).toMatchObject({
              resumeOnStartup: false,
            });
          });
          await second.daemon.stop();
        }
        const final = await launch(nextClients, pino({ level: "silent" }));
        await final.daemon.stop({ resumeAgents: true });
        expect(startTurn).toHaveBeenCalledOnce();
        expect(accepted.mock.calls.map(([prompt]) => prompt)).toEqual(
          outcome === "late-start" ? [] : ["Resume working."],
        );
      } finally {
        vi.useRealTimers();
        providerOutcome.resolve();
        for (const handle of handles.toReversed()) {
          await handle.close();
          await rm(handle.staticDir, { recursive: true, force: true });
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  const automaticRecoverySettingsChanges = [
    "stay-enabled",
    "toggle-after-rejection",
    "toggle-before-rejection",
    "toggle-before-confirmation",
  ] as const;
  test.each(automaticRecoverySettingsChanges)(
    "automatic startup recovery handles live settings change (%s)",
    async (scenario) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-auto-opt-out-"));
      const home = path.join(root, ".paseo");
      const marker = path.join(home, "restart-recovery-pending.json");
      const storage = new AgentStorage(path.join(home, "agents"), pino({ level: "silent" }));
      const stamp = new Date().toISOString();
      const id = randomUUID();
      const explicitId = randomUUID();
      const oneShotMarker = path.join(home, "restart-recovery-once.json");
      const entered = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<void>();
      const reported = Promise.withResolvers<void>();
      const automaticPrompts: unknown[] = [];
      const logger = pino({ level: "silent" });
      const bootstrapLogger = logger.child({ module: "bootstrap" });
      vi.spyOn(logger, "child").mockReturnValueOnce(bootstrapLogger);
      vi.spyOn(bootstrapLogger, "error").mockImplementation((_error, msg) => {
        if (msg === "Agent restart recovery failed") reported.resolve();
      });
      const providers = createTestAgentClients();
      const codex = providers.codex!;
      const resume = codex.resumeSession.bind(codex);
      vi.spyOn(codex, "resumeSession").mockImplementation(async (...args) => {
        const session = await resume(...args);
        const start = session.startTurn?.bind(session);
        if (!start) throw new Error("Test session must support starting a turn");
        session.startTurn = async (...turn) => {
          if (args[0].sessionId === id) {
            automaticPrompts.push(turn[0]);
            entered.resolve();
            await pending.promise;
          } else {
            throw new Error("The one-shot provider rejects the first start");
          }
          return start(...turn);
        };
        return session;
      });
      const handles: Awaited<ReturnType<typeof createTestPaseoDaemon>>[] = [];
      let client: DaemonClient | undefined;
      const launch = async (agentClients: typeof providers, instanceLogger?: typeof logger) => {
        const handle = await createTestPaseoDaemon({
          paseoHomeRoot: root,
          cleanup: false,
          logger: instanceLogger,
          resumeOnStartup: true,
          agentClients,
        });
        handles.push(handle);
        return handle;
      };
      try {
        for (const agentId of [id, explicitId]) {
          await storage.upsert(
            parseStoredAgentRecord({
              id: agentId,
              provider: "codex",
              cwd: root,
              createdAt: stamp,
              updatedAt: stamp,
              lastStatus: agentId === id ? "running" : "closed",
              resumeOnStartup: true,
              persistence: { provider: "codex", sessionId: agentId },
            }),
          );
        }
        await writeFile(oneShotMarker, JSON.stringify({ version: 2, agentIds: [explicitId] }));
        await writeFile(marker, JSON.stringify({ version: 2, agentIds: [id, explicitId] }));
        const first = await launch(providers, logger);
        await entered.promise;
        expect(JSON.parse(await readFile(marker, "utf8")).agentIds).toEqual([id]);
        client = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws` });
        await client.connect();
        const reject = async () => {
          pending.reject(new Error("Provider rejected the automatic continuation"));
          await expect
            .poll(async () => (await first.daemon.agentStorage.get(id))?.lastStatus)
            .toBe("error");
          await reported.promise;
        };
        if (scenario === "toggle-before-confirmation") {
          await client.patchDaemonConfig({ resumeOnStartup: false });
          await client.patchDaemonConfig({ resumeOnStartup: true });
          pending.resolve();
          await expect
            .poll(async () => (await first.daemon.agentStorage.get(id))?.lastStatus)
            .toBe("idle");
        } else if (scenario === "toggle-before-rejection") {
          await client.patchDaemonConfig({ resumeOnStartup: false });
          await client.patchDaemonConfig({ resumeOnStartup: true });
          await reject();
        } else {
          await reject();
          if (scenario === "toggle-after-rejection") {
            await client.patchDaemonConfig({ resumeOnStartup: false });
            await client.patchDaemonConfig({ resumeOnStartup: true });
          }
        }
        expect(JSON.parse(await readFile(oneShotMarker, "utf8")).agentIds).toEqual([explicitId]);
        if (scenario === "stay-enabled") {
          expect(JSON.parse(await readFile(marker, "utf8")).agentIds).toEqual([id]);
        } else {
          await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          expect((await first.daemon.agentStorage.get(id))?.resumeOnStartup).toBe(false);
        }
        await first.daemon.stop();
        const resumed: string[] = [];
        const nextProviders = createTestAgentClients();
        const nextCodex = nextProviders.codex!;
        const nextResume = nextCodex.resumeSession.bind(nextCodex);
        vi.spyOn(nextCodex, "resumeSession").mockImplementation(async (...args) => {
          resumed.push(args[0].sessionId);
          return nextResume(...args);
        });
        const next = await launch(nextProviders);
        await expect
          .poll(() => next.daemon.agentStorage.get(explicitId))
          .toMatchObject({ resumeOnStartup: false });
        expect(resumed.toSorted()).toEqual(
          (scenario === "stay-enabled" ? [id, explicitId] : [explicitId]).toSorted(),
        );
        expect(automaticPrompts).toEqual(["Resume working."]);
      } finally {
        pending.resolve();
        await client?.close();
        for (const handle of handles.toReversed()) {
          await handle.close();
          await rm(handle.staticDir, { force: true, recursive: true });
        }
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  test.each([
    { settings: "disabled then enabled", changes: [false, true], automaticCommands: [] },
    { settings: "kept enabled", changes: [], automaticCommands: ["/goal pause"] },
  ])(
    "custom automatic recovery command queued behind an ordinary command with settings $settings",
    async (scenario) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-recovery-command-"));
      const home = path.join(root, ".paseo");
      const marker = path.join(home, "restart-recovery-pending.json");
      const id = randomUUID();
      const waitingForRecoveryRead = Promise.withResolvers<void>();
      const allowRecoveryRead = Promise.withResolvers<void>();
      const ordinaryRunning = Promise.withResolvers<void>();
      const allowOrdinary = Promise.withResolvers<void>();
      const recoveryParsed = Promise.withResolvers<void>();
      const recoveryRunning = Promise.withResolvers<void>();
      const allowRecoveryCommand = Promise.withResolvers<void>();
      const fenceRan = Promise.withResolvers<void>();
      const commands: string[] = [];
      const clients = createTestAgentClients();
      const codex = clients.codex!;
      const resume = codex.resumeSession.bind(codex);
      vi.spyOn(codex, "resumeSession").mockImplementation(async (...args) => {
        const provider = await resume(...args);
        provider.tryHandleOutOfBand = (prompt) => {
          if (typeof prompt !== "string") return null;
          if (prompt === "/goal pause") recoveryParsed.resolve();
          return {
            run: async ({ beforeProviderDispatch, onProviderOutcome }) => {
              if (prompt === "/goal pause") await beforeProviderDispatch?.();
              commands.push(prompt);
              if (prompt === "/goal pause") onProviderOutcome?.();
              if (prompt === "/compact") {
                ordinaryRunning.resolve();
                await allowOrdinary.promise;
              }
              if (prompt === "/goal pause") {
                recoveryRunning.resolve();
                await allowRecoveryCommand.promise;
              }
              if (prompt === "/goal resume") fenceRan.resolve();
            },
          };
        };
        return provider;
      });
      let daemon: Awaited<ReturnType<typeof createPaseoDaemon>> | undefined;
      let client: DaemonClient | undefined;
      try {
        const storage = new AgentStorage(path.join(home, "agents"), pino({ level: "silent" }));
        const timestamp = new Date().toISOString();
        await storage.upsert(
          parseStoredAgentRecord({
            id,
            provider: "codex",
            cwd: root,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastStatus: "error",
            persistence: { provider: "codex", sessionId: id },
          }),
        );
        await writeFile(marker, JSON.stringify({ version: 2, agentIds: [id] }));
        daemon = await createPaseoDaemon(
          {
            ...loadConfig(home, { env: {} }),
            listen: "127.0.0.1:0",
            staticDir: root,
            agentStoragePath: path.join(home, "agents"),
            agentClients: clients,
            mcpEnabled: false,
            relayEnabled: false,
            pluginsEnabled: false,
            resumeOnStartup: true,
            resumePrompt: "/goal pause",
          },
          pino({ level: "silent" }),
        );
        const read = daemon.agentStorage.get.bind(daemon.agentStorage);
        let pauseRead = true;
        vi.spyOn(daemon.agentStorage, "get").mockImplementation(async (agentId) => {
          if (agentId === id && pauseRead && daemon?.getListenTarget()) {
            pauseRead = false;
            waitingForRecoveryRead.resolve();
            await allowRecoveryRead.promise;
          }
          return read(agentId);
        });
        await daemon.start();
        await waitingForRecoveryRead.promise;
        const listen = daemon.getListenTarget();
        if (listen?.type !== "tcp") throw new Error("Expected an isolated TCP listener");
        client = new DaemonClient({ url: `ws://127.0.0.1:${listen.port}/ws` });
        await client.connect();
        await client.sendMessage(id, "/compact");
        await ordinaryRunning.promise;
        allowRecoveryRead.resolve();
        await recoveryParsed.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(commands).toEqual(["/compact"]);
        if (scenario.changes.length) {
          for (const enabled of scenario.changes) {
            const updated = await client.patchDaemonConfig({ resumeOnStartup: enabled });
            expect(updated.config.resumeOnStartup).toBe(enabled);
          }
          await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          await expect(daemon.stop({ resumeAgents: true })).rejects.toThrow(
            "startup recovery is still in progress",
          );
          expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
            version: 2,
            agentIds: [id],
          });
        }
        // The manual command still acknowledges queueing while the first command is running.
        await client.sendMessage(id, "/goal resume");
        expect(commands).toEqual(["/compact"]);
        allowOrdinary.resolve();
        if (scenario.automaticCommands.length) {
          await recoveryRunning.promise;
          // Handoff is enough to consume the marker while the command remains active.
          await vi.waitFor(() =>
            expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" }),
          );
        }
        allowRecoveryCommand.resolve();
        await fenceRan.promise;
        expect(commands).toEqual(["/compact", ...scenario.automaticCommands, "/goal resume"]);
      } finally {
        allowRecoveryRead.resolve();
        allowOrdinary.resolve();
        allowRecoveryCommand.resolve();
        await client?.close();
        await daemon?.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    12_000,
  );

  test.each(["before recovery", "after rejection"] as const)(
    "an accepted foreground turn takes over automatic startup recovery %s",
    async (timing) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-manual-recovery-takeover-"));
      const home = path.join(root, ".paseo");
      const id = randomUUID();
      const marker = path.join(home, "restart-recovery-pending.json");
      const logger = pino({ level: "silent" });
      const timestamp = new Date().toISOString();
      const seed = new AgentStorage(path.join(home, "agents"), logger);
      const waiting = Promise.withResolvers<void>();
      const continueRecovery = Promise.withResolvers<void>();
      const manual = "Continue with my instructions.";
      const attempts: string[] = [];
      const providers = createTestAgentClients();
      const provider = providers.codex!;
      const resume = provider.resumeSession.bind(provider);
      vi.spyOn(provider, "resumeSession").mockImplementation(async (...args) => {
        const session = await resume(...args);
        const start = session.startTurn.bind(session);
        session.startTurn = async (prompt, options) => {
          attempts.push(String(prompt));
          if (prompt === "Resume working.") throw new Error("Provider refused automatic start");
          return start(prompt, options);
        };
        return session;
      });
      let first: Awaited<ReturnType<typeof createPaseoDaemon>> | undefined;
      let second: Awaited<ReturnType<typeof createTestPaseoDaemon>> | undefined;
      let client: DaemonClient | undefined;
      try {
        await seed.upsert(
          parseStoredAgentRecord({
            id,
            provider: "codex",
            cwd: root,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastStatus: "closed",
            persistence: { provider: "codex", sessionId: id },
          }),
        );
        await writeFile(marker, JSON.stringify({ version: 2, agentIds: [id] }));
        first = await createPaseoDaemon(
          {
            ...loadConfig(home, { env: {} }),
            listen: "127.0.0.1:0",
            staticDir: root,
            agentStoragePath: path.join(home, "agents"),
            agentClients: providers,
            mcpEnabled: false,
            relayEnabled: false,
            pluginsEnabled: false,
            resumeOnStartup: true,
          },
          logger,
        );
        const read = first.agentStorage.get.bind(first.agentStorage);
        let firstRead = true;
        vi.spyOn(first.agentStorage, "get").mockImplementation(async (agentId) => {
          if (agentId === id && firstRead && first?.getListenTarget()) {
            firstRead = false;
            waiting.resolve();
            await continueRecovery.promise;
          }
          return read(agentId);
        });
        await first.start();
        await waiting.promise;
        const listen = first.getListenTarget();
        if (listen?.type !== "tcp") throw new Error("Expected an isolated TCP listener");
        client = new DaemonClient({ url: `ws://127.0.0.1:${listen.port}/ws` });
        await client.connect();
        if (timing === "after rejection") {
          continueRecovery.resolve();
          await vi.waitFor(() => expect(first?.agentManager.getAgent(id)?.lifecycle).toBe("error"));
          expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({ agentIds: [id] });
        }
        await client.sendMessage(id, manual);
        expect((await client.waitForFinish(id, 5000)).status).toBe("idle");
        continueRecovery.resolve();
        await vi.waitFor(() =>
          expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" }),
        );
        await client.close();
        await vi.waitFor(() => first!.stop({ resumeAgents: true }));
        expect(attempts).toEqual(
          timing === "after rejection" ? ["Resume working.", manual] : [manual],
        );
        const restarted = vi.fn();
        second = await createTestPaseoDaemon({
          paseoHomeRoot: root,
          cleanup: false,
          resumeOnStartup: true,
          agentClients: createTestAgentClients({ onStartTurn: restarted }),
        });
        await second.daemon.stop({ resumeAgents: true });
        expect(restarted).not.toHaveBeenCalled();
      } finally {
        continueRecovery.resolve();
        await client?.close();
        await first?.stop();
        await second?.close();
        if (second) await rm(second.staticDir, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    { settings: "kept enabled", changes: [], automaticStarts: ["Resume working."], retry: false },
    { settings: "disabled", changes: [false], automaticStarts: [], retry: false },
    {
      settings: "disabled then enabled",
      changes: [false, true],
      automaticStarts: [],
      retry: false,
    },
    {
      settings: "disabled then enabled during reopen",
      changes: [false, true],
      automaticStarts: [],
      retry: true,
    },
  ])("startup recovery while opening sessions with settings $settings", async (scenario) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-recovery-opening-"));
    const home = path.join(root, ".paseo");
    const automaticMarker = path.join(home, "restart-recovery-pending.json");
    const oneShotMarker = path.join(home, "restart-recovery-once.json");
    const automaticId = randomUUID();
    const oneShotId = randomUUID();
    const storage = new AgentStorage(path.join(home, "agents"), pino({ level: "silent" }));
    const allowOpen = Promise.withResolvers<void>();
    const automaticOpening = Promise.withResolvers<void>();
    const oneShotOpening = Promise.withResolvers<void>();
    const starts = vi.fn<(id: string, prompt: unknown) => void>();
    const providers = createTestAgentClients();
    const codex = providers.codex!;
    const resume = codex.resumeSession.bind(codex);
    let automaticOpens = 0;
    vi.spyOn(codex, "resumeSession").mockImplementation(async (handle, ...args) => {
      const automatic = handle.sessionId === automaticId;
      const stale = automatic && scenario.retry && ++automaticOpens === 1;
      if (!stale) {
        (automatic ? automaticOpening : oneShotOpening).resolve();
        await allowOpen.promise;
      }
      const session = await resume(handle, ...args);
      const start = session.startTurn.bind(session);
      session.startTurn = (prompt, options) => {
        if (stale) return Promise.reject(new StaleProviderSessionError(handle.sessionId));
        starts(handle.sessionId, prompt);
        return start(prompt, options);
      };
      return session;
    });
    let daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>> | undefined;
    let client: DaemonClient | undefined;
    try {
      const timestamp = new Date().toISOString();
      for (const id of [automaticId, oneShotId]) {
        await storage.upsert(
          parseStoredAgentRecord({
            id,
            provider: "codex",
            cwd: root,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastStatus: id === automaticId ? "error" : "closed",
            persistence: { provider: "codex", sessionId: id },
          }),
        );
      }
      await writeFile(automaticMarker, JSON.stringify({ version: 2, agentIds: [automaticId] }));
      await writeFile(oneShotMarker, JSON.stringify({ version: 2, agentIds: [oneShotId] }));
      const handle = await createTestPaseoDaemon({
        paseoHomeRoot: root,
        resumeOnStartup: true,
        agentClients: providers,
      });
      daemon = handle;
      await Promise.all([automaticOpening.promise, oneShotOpening.promise]);
      client = new DaemonClient({ url: `ws://127.0.0.1:${handle.port}/ws` });
      await client.connect();
      for (const enabled of scenario.changes) {
        const updated = await client.patchDaemonConfig({ resumeOnStartup: enabled });
        expect(updated.config.resumeOnStartup).toBe(enabled);
      }
      allowOpen.resolve();
      const promptsFor = (id: string) =>
        starts.mock.calls.filter(([agentId]) => agentId === id).map(([, prompt]) => prompt);
      const manualPrompts = scenario.changes.length ? ["Continue with my instructions."] : [];
      for (const prompt of manualPrompts) {
        await client.sendMessage(automaticId, prompt);
        await vi.waitFor(() => expect(promptsFor(automaticId)).toContain(prompt));
      }
      // A stop with recovery is refused until both startup attempts settle.
      await vi.waitFor(() => handle.daemon.stop({ resumeAgents: true }), { timeout: 5_000 });
      expect(promptsFor(automaticId)).toEqual([...scenario.automaticStarts, ...manualPrompts]);
      expect(promptsFor(oneShotId)).toEqual(["Resume working."]);
      await expect(readFile(automaticMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      allowOpen.resolve();
      await client?.close();
      await daemon?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("standalone listener exposes services only", async () => {
    const standalonePort = await findFreePort();
    const upstream = http.createServer((_req, res) => {
      res.end("service-ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Expected upstream TCP address");
    }

    const daemonHandle = await createTestPaseoDaemon({
      serviceProxy: { standaloneListen: `127.0.0.1:${standalonePort}` },
    });
    try {
      daemonHandle.daemon.serviceProxy.registerWorkspaceService({
        workspaceId: "workspace-standalone",
        projectSlug: "repo",
        branchName: "main",
        scriptName: "web",
        port: upstreamAddress.port,
      });

      const serviceResponse = await httpGetWithHost(
        standalonePort,
        `web--repo.localhost:${standalonePort}`,
        "/",
      );
      expect(serviceResponse.status).toBe(200);
      expect(await serviceResponse.text()).toBe("service-ok");

      for (const requestPath of ["/api/health", "/ws", "/mcp/agents", "/index.html", "/files/x"]) {
        const response = await httpGetWithHost(
          standalonePort,
          `daemon.localhost:${standalonePort}`,
          requestPath,
        );
        expect(response.status).toBe(404);
      }
    } finally {
      await daemonHandle.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("rolls back standalone listener without starting plugins when main listen fails", async () => {
    const mainPort = await findFreePort();
    const occupiedMain = http.createServer((_req, res) => {
      res.end("occupied-main");
    });
    await new Promise<void>((resolve) => occupiedMain.listen(mainPort, "127.0.0.1", resolve));
    const standalonePort = await findFreePort();

    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-main-rollback-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const pluginDirectory = path.join(paseoHomeRoot, "plugin");
    const pluginPidPath = path.join(pluginDirectory, "plugin.pid");
    await mkdir(paseoHome, { recursive: true });
    if (!isPlatform("win32")) {
      await mkdir(pluginDirectory);
      await writeFile(
        path.join(pluginDirectory, "paseo-plugin.json"),
        JSON.stringify({
          id: "startup-rollback",
          requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
        }),
      );
      await writeFile(
        path.join(pluginDirectory, "index.server.ts"),
        `import { writeFileSync } from "node:fs";
export default function contribute(plugin: unknown) {
  void plugin;
  writeFileSync(${JSON.stringify(pluginPidPath)}, String(process.pid));
}`,
      );
    }
    const config: PaseoDaemonConfig = {
      listen: `127.0.0.1:${mainPort}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
      serviceProxy: { standaloneListen: `127.0.0.1:${standalonePort}` },
      pluginsEnabled: !isPlatform("win32"),
      plugins: isPlatform("win32")
        ? {}
        : { "startup-rollback": { source: "directory", path: pluginDirectory } },
    };
    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));

    try {
      await expect(daemon.start()).rejects.toThrow();
      await expect(fetch(`http://127.0.0.1:${standalonePort}/api/health`)).rejects.toThrow();
      if (!isPlatform("win32")) {
        await expect(readFile(pluginPidPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await daemon.stop().catch(() => undefined);
      await new Promise<void>((resolve) => occupiedMain.close(() => resolve()));
      await rm(paseoHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("redacts Agent MCP debug request credentials and bodies", async () => {
    const logLines: string[] = [];
    const logger = pino(
      { level: "debug" },
      {
        write: (line: string) => {
          logLines.push(line);
        },
      },
    );
    const daemonHandle = await createTestPaseoDaemon({
      logger,
      mcpDebug: true,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${daemonHandle.port}/mcp/agents`, {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-debug-token",
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            apiKey: "secret-body-token",
          },
        }),
      });

      await response.text();
      const logs = logLines.join("\n");
      expect(logs).toContain("Agent MCP request");
      expect(logs).toContain("[redacted]");
      expect(logs).toContain('"method":"tools/call"');
      expect(logs).toContain('"hasParams":true');
      expect(logs).not.toContain("secret-debug-token");
      expect(logs).not.toContain("secret-body-token");
      expect(logs).not.toContain("apiKey");
    } finally {
      await daemonHandle.close();
    }
  });

  test("starts when OpenAI speech provider is configured without credentials", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-openai-config-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    await mkdir(paseoHome, { recursive: true });

    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
    };

    try {
      const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
      try {
        await daemon.start();
        expect(daemon.getListenTarget()).toBeDefined();
        // Must also stop without throwing
      } finally {
        await daemon.stop();
      }
    } finally {
      await rm(paseoHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("does not block daemon start on local speech model downloads", async () => {
    const originalFetch = globalThis.fetch;
    let releaseFetch: ((value: Response) => void) | null = null;
    const fetchGate = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchGate),
    );

    const daemonHandle = await createTestPaseoDaemon({
      speech: {
        providers: {
          dictationStt: { provider: "local", explicit: true, enabled: true },
          voiceTurnDetection: { provider: "local", explicit: true, enabled: false },
          voiceStt: { provider: "local", explicit: true, enabled: false },
          voiceTts: { provider: "local", explicit: true, enabled: false },
        },
        local: {
          modelsDir: path.join(os.tmpdir(), `paseo-missing-models-${Date.now()}`),
          models: {
            dictationStt: "parakeet-tdt-0.6b-v2-int8",
            voiceStt: "parakeet-tdt-0.6b-v2-int8",
            voiceTts: "kokoro-en-v0_19",
          },
        },
      },
    });

    try {
      const response = await originalFetch(`http://127.0.0.1:${daemonHandle.port}/api/health`);
      expect(response.ok).toBe(true);
    } finally {
      releaseFetch?.(
        new Response(null, {
          status: 500,
          statusText: "test cleanup",
        }),
      );
      vi.unstubAllGlobals();
      globalThis.fetch = originalFetch;
      await daemonHandle.close();
    }
  });

  test("parses whitespace-padded numeric port strings", () => {
    expect(parseListenString(" 6767 ")).toEqual({
      type: "tcp",
      host: "127.0.0.1",
      port: 6767,
    });
  });

  test("parses IPv6 listen targets correctly", () => {
    expect(parseListenString("[::1]:6767")).toEqual({
      type: "tcp",
      host: "::1",
      port: 6767,
    });
    expect(parseListenString("[::]:6767")).toEqual({
      type: "tcp",
      host: "::",
      port: 6767,
    });
  });

  test("rejects Windows absolute paths that are not named pipes", () => {
    // A Windows drive path like C:\daemon must NOT be silently parsed as TCP
    // (split(":") would yield host="C" and port="\\daemon" which is nonsensical).
    expect(() => parseListenString(String.raw`C:\daemon`)).toThrow();
    expect(() => parseListenString(String.raw`D:\Users\foo\.paseo\daemon.sock`)).toThrow();
    // Single-letter "host" with no valid port is not a valid listen string
    expect(() => parseListenString(String.raw`C:\some\path`)).toThrow();
  });

  test("parses Windows named pipes as managed IPC listen targets", () => {
    expect(parseListenString(String.raw`\\.\pipe\paseo-managed-test`)).toEqual({
      type: "pipe",
      path: String.raw`\\.\pipe\paseo-managed-test`,
    });
    expect(parseListenString(`pipe://${String.raw`\\.\pipe\paseo-managed-test`}`)).toEqual({
      type: "pipe",
      path: String.raw`\\.\pipe\paseo-managed-test`,
    });
  });

  // POSIX-only: Unix socket listen paths are invalid Windows listen targets.
  test.skipIf(isPlatform("win32"))(
    "generates a relay pairing offer for unix socket listeners",
    async () => {
      const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-socket-relay-"));
      const paseoHome = path.join(paseoHomeRoot, ".paseo");
      const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
      const socketPath = path.join(paseoHomeRoot, "run", "paseo.sock");
      await mkdir(path.dirname(socketPath), { recursive: true });
      await mkdir(paseoHome, { recursive: true });
      const logger = pino({ level: "silent" });

      const config: PaseoDaemonConfig = {
        listen: socketPath,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
        relayEnabled: true,
        relayEndpoint: "127.0.0.1:9",
        relayPublicEndpoint: "127.0.0.1:9",
        appBaseUrl: "https://app.paseo.sh",
        openai: undefined,
        speech: undefined,
      };

      const daemon = await createPaseoDaemon(config, logger);

      try {
        await daemon.start();
        const pairing = await generateLocalPairingOffer({
          paseoHome,
          relayEnabled: true,
          relayEndpoint: "127.0.0.1:9",
          relayPublicEndpoint: "127.0.0.1:9",
          appBaseUrl: "https://app.paseo.sh",
          includeQr: false,
        });
        expect(pairing.relayEnabled).toBe(true);
        expect(pairing.url?.startsWith("https://app.paseo.sh/#offer=")).toBe(true);
      } finally {
        await daemon.stop().catch(() => undefined);
        await daemon.agentManager.flush().catch(() => undefined);
        await rm(paseoHomeRoot, { recursive: true, force: true });
        await rm(staticDir, { recursive: true, force: true });
      }
    },
  );
});

function holdAgentClose(): HeldAgentClose {
  let armed = false;
  let markStarted = () => {};
  let finish = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    started,
    arm() {
      armed = true;
    },
    async closeSession() {
      if (!armed) {
        return;
      }
      markStarted();
      await finished;
    },
    finish: () => finish(),
  };
}

async function beginDaemonShutdownWithAgentClosing(): Promise<BlockedDaemonShutdown> {
  const heldAgentClose = holdAgentClose();
  const daemonHandle = await createTestPaseoDaemon({
    cleanup: false,
    agentClients: createTestAgentClients({ closeSession: heldAgentClose.closeSession }),
  });
  const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-shutdown-agent-"));
  await daemonHandle.daemon.agentManager.createAgent(
    {
      provider: "codex",
      cwd: agentCwd,
    },
    undefined,
    { workspaceId: undefined },
  );

  heldAgentClose.arm();
  const stopPromise = daemonHandle.daemon.stop();
  await heldAgentClose.started;

  return {
    probeReconnect: () => probeWebSocketConnection(`ws://127.0.0.1:${daemonHandle.port}/ws`),
    async tryCreateAgent() {
      try {
        await daemonHandle.daemon.agentManager.createAgent(
          {
            provider: "codex",
            cwd: agentCwd,
          },
          undefined,
          { workspaceId: undefined },
        );
        return "created";
      } catch (error) {
        if (error instanceof AgentManagerShuttingDownError) {
          return "rejected";
        }
        throw error;
      }
    },
    async finish() {
      heldAgentClose.finish();
      await stopPromise;
      await daemonHandle.daemon.agentManager.flush().catch(() => undefined);
      await Promise.all([
        rm(path.dirname(daemonHandle.paseoHome), { recursive: true, force: true }),
        rm(daemonHandle.staticDir, { recursive: true, force: true }),
        rm(agentCwd, { recursive: true, force: true }),
      ]);
    },
  };
}

function probeWebSocketConnection(
  url: string,
  headers?: { host?: string; origin?: string },
): Promise<WebSocketProbeResult> {
  const ws = new WebSocket(url, {
    headers: {
      ...(headers?.host ? { Host: headers.host } : {}),
      ...(headers?.origin ? { Origin: headers.origin } : {}),
    },
  });
  return new Promise((resolve) => {
    ws.once("open", () => {
      ws.close();
      resolve({ status: "connected" });
    });
    ws.once("error", () => resolve({ status: "rejected", statusCode: null }));
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ status: "rejected", statusCode: response.statusCode ?? null });
    });
  });
}

test("disabled recovery closes stale active records without resuming sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-stale-status-"));
  const logger = pino({ level: "silent" });
  const storagePath = path.join(root, ".paseo", "agents");
  const storage = new AgentStorage(storagePath, logger);
  const timestamp = "2025-01-01T00:00:00.000Z";
  const registryDir = path.join(root, ".paseo", "projects");
  await new FileBackedProjectRegistry(path.join(registryDir, "projects.json"), logger).upsert(
    createPersistedProjectRecord({
      projectId: "existing-project",
      rootPath: root,
      kind: "non_git",
      displayName: "Existing",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  await new FileBackedWorkspaceRegistry(path.join(registryDir, "workspaces.json"), logger).upsert(
    createPersistedWorkspaceRecord({
      workspaceId: "existing-workspace",
      projectId: "existing-project",
      cwd: root,
      kind: "directory",
      displayName: "Existing",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  const records: StoredAgentRecord[] = ["running", "initializing", "idle", "error", "closed"].map(
    (status, index) => ({
      id: randomUUID(),
      workspaceId: "existing-workspace",
      provider: "codex",
      cwd: root,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      lastActivityAt: "2025-01-02T00:00:00.000Z",
      lastStatus: status as StoredAgentRecord["lastStatus"],
      title: `Keep ${status}`,
      labels: { "paseo.parent-agent-id": "parent", custom: "keep" },
      metadata: {},
      persistence: { provider: "codex", sessionId: `session-${index}` },
      config: { modeId: "full-access" },
      requiresAttention: true,
      attentionReason: "permission",
      attentionTimestamp: "2025-01-02T00:00:00.000Z",
      archivedAt: index === 1 ? "2025-01-03T00:00:00.000Z" : null,
    }),
  );
  for (const record of records) await storage.upsert(record);
  let sessionsCreated = 0;
  const handle = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    resumeOnStartup: false,
    agentClients: createTestAgentClients({
      beforeCreateSession: async () => {
        sessionsCreated++;
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${handle.port}/ws` });
  try {
    const expected = records.map((record) => ({
      ...record,
      resumeOnStartup: false,
      lastStatus:
        record.lastStatus === "running" || record.lastStatus === "initializing"
          ? "closed"
          : record.lastStatus,
    }));
    expect(
      (await handle.daemon.agentStorage.listAll()).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
    // A fresh reader proves the repaired states were written, rather than projected only in memory.
    expect(
      (await new AgentStorage(storagePath, logger).listAll()).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    ).toEqual(expected);
    expect(handle.daemon.agentManager.listAgents()).toEqual([]);
    expect(sessionsCreated).toBe(0);
    await client.connect();
    const snapshot = await client.fetchAgents({ filter: { includeArchived: true } });
    expect(
      Object.fromEntries(snapshot.entries.map((entry) => [entry.agent.id, entry.agent.status])),
    ).toEqual(Object.fromEntries(expected.map((record) => [record.id, record.lastStatus])));
    const opened = await ensureAgentLoaded(records[0]!.id, {
      agentManager: handle.daemon.agentManager,
      agentStorage: handle.daemon.agentStorage,
      logger,
    });
    expect(opened.id).toBe(records[0]!.id);
    expect(opened.persistence?.sessionId).toBe("session-0");
    expect(opened.lifecycle).toBe("idle");
    await handle.daemon.agentManager.runAgent(opened.id, "hello");
    expect(handle.daemon.agentManager.getAgent(opened.id)?.lifecycle).toBe("idle");
  } finally {
    await client.close();
    await handle.close();
  }
}, 30_000);

test.each(["reject", "stall"] as const)(
  "shutdown closes Claude and its process despite a %s peer and stalled SDK handshake",
  async (failure) => {
    let child: ChildProcess | undefined;
    let ready!: () => void;
    const processReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let finishStream!: () => void;
    const streamFinished = new Promise<void>((resolve) => {
      finishStream = resolve;
    });
    const never = new Promise<never>(() => {});
    const claude = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
      resolveBinary: async () => process.execPath,
      queryFactory: ({ options }) => {
        child = options.spawnClaudeCodeProcess!({
          command: process.execPath,
          args: [
            "-e",
            "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
          ],
          cwd: process.cwd(),
          env: process.env,
          signal: new AbortController().signal,
        }) as ChildProcess;
        child.stdout!.once("data", ready);
        let initialized = false;
        // An injected SDK adapter leaves an active turn and both close requests unanswered.
        return {
          async next() {
            if (!initialized) {
              initialized = true;
              return {
                done: false,
                value: {
                  type: "system",
                  subtype: "init",
                  session_id: "shutdown-session",
                  permissionMode: "default",
                },
              };
            }
            await streamFinished;
            return { done: true, value: undefined };
          },
          interrupt: () => never,
          return: () => never,
          close() {},
          async supportedModels() {
            return [];
          },
          async supportedCommands() {
            return [];
          },
          async setPermissionMode() {},
          async setModel() {},
          async applyFlagSettings() {},
          [Symbol.asyncIterator]() {
            return this;
          },
        } as Query;
      },
    });
    let armed = false;
    let peerRunning!: () => void;
    const peerReady = new Promise<void>((resolve) => {
      peerRunning = resolve;
    });
    const peers = createTestAgentClients({
      beforeTurnComplete: async () => {
        peerRunning();
        await streamFinished;
      },
      closeSession: async () => {
        if (!armed) return;
        if (failure === "reject") throw new Error("peer close rejected");
        await never;
      },
    });
    const handle = await createTestPaseoDaemon({ agentClients: { claude, codex: peers.codex } });
    let stopped = false;
    let run: Promise<unknown> | undefined;
    let peerRun: Promise<unknown> | undefined;
    try {
      const agent = await handle.daemon.agentManager.createAgent(
        { provider: "claude", cwd: handle.paseoHome },
        undefined,
        { workspaceId: undefined },
      );
      run = handle.daemon.agentManager.runAgent(agent.id, "keep working").catch(() => undefined);
      await processReady;
      expect(handle.daemon.agentManager.getAgent(agent.id)?.lifecycle).toBe("running");
      const peer = await handle.daemon.agentManager.createAgent(
        { provider: "codex", cwd: handle.paseoHome, modeId: "full-access" },
        undefined,
        { workspaceId: undefined },
      );
      peerRun = handle.daemon.agentManager.runAgent(peer.id, "keep working").catch(() => undefined);
      await peerReady;
      armed = true;
      await handle.daemon.stop();
      stopped = true;
      // Windows taskkill is forceful on the first signal; POSIX escalates after SIGTERM.
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
      expect((await handle.daemon.agentStorage.get(agent.id))?.lastStatus).toBe("closed");
      expect(handle.daemon.agentManager.getAgent(agent.id)).toBeNull();
      expect((await handle.daemon.agentStorage.get(peer.id))?.lastStatus).toBe("running");
    } finally {
      finishStream();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      if (!stopped) await handle.daemon.stop();
      await Promise.all([run, peerRun]);
      await rm(path.dirname(handle.paseoHome), { recursive: true, force: true });
      await rm(handle.staticDir, { recursive: true, force: true });
    }
  },
  30_000,
);
