import { addAbortListener } from "node:events";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Agent, fetch, ProxyAgent } from "undici";
import { WebSocket } from "ws";
import { snapshotEnvironmentProxy } from "./index.js";
import { createProxyPolicy } from "./proxy-policy.js";
import type {
  HostProxySettings,
  ProxyCredential,
  ProxyCredentials,
  ProxySlot,
} from "./proxy-settings.js";

type TargetScheme = "http" | "https";
interface Endpoint {
  url: string;
  authorization?: string;
}

const DIAGNOSTIC_HTTPS_TARGET = "https://relay.paseo.sh/health";
// Use a source-owned diagnostic identity as a client. It sends no application frames.
const DIAGNOSTIC_WSS_TARGET =
  "wss://relay.paseo.sh/ws?role=client&serverId=paseo-network-diagnostics&v=2";

const diagnosticTargets = {
  http: {
    http: DIAGNOSTIC_HTTPS_TARGET.replace(/^https:/, "http:"),
    webSocket: DIAGNOSTIC_WSS_TARGET.replace(/^wss:/, "ws:"),
    checks: [
      { protocol: "http", port: 80 },
      { protocol: "ws", port: 80 },
    ],
    upgrade: {
      http: DIAGNOSTIC_HTTPS_TARGET,
      webSocket: DIAGNOSTIC_WSS_TARGET.replace(/^wss:/, "https:"),
    },
  },
  https: {
    http: DIAGNOSTIC_HTTPS_TARGET,
    webSocket: DIAGNOSTIC_WSS_TARGET,
    checks: [
      { protocol: "https", port: 443 },
      { protocol: "wss", port: 443 },
    ],
    upgrade: undefined,
  },
} as const;

export interface ProxyDiagnosticCoverage {
  proxySlot: ProxySlot | null;
  checks: (typeof diagnosticTargets)[TargetScheme]["checks"];
}

function endpoint(url: string, credential?: ProxyCredential): Endpoint {
  return {
    url,
    authorization: credential
      ? `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`
      : undefined,
  };
}

function environmentEndpoint(value: string): Endpoint | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  return endpoint(
    url.origin,
    url.username || url.password
      ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
      : undefined,
  );
}

function websocketProxyConnection(
  proxy: Endpoint,
  address: URL,
  signal: AbortSignal,
): HttpAgent["createConnection"] {
  return (_options, callback) => {
    if (!callback) throw new Error("Missing WebSocket tunnel callback");
    const hostname = address.hostname.replace(/^\[|\]$/g, "");
    const secure = address.protocol === "wss:";
    const port = address.port || (secure ? "443" : "80");
    const authority = `${address.hostname}:${port}`;
    const request = proxy.url.startsWith("https:") ? httpsRequest : httpRequest;
    const connect = request(proxy.url, {
      method: "CONNECT",
      path: authority,
      agent: false,
      headers: { host: authority },
      signal,
      rejectUnauthorized: true,
    });
    if (proxy.authorization) connect.setHeader("proxy-authorization", proxy.authorization);
    connect.once("error", () =>
      callback(new Error("WebSocket proxy connection failed"), undefined!),
    );
    connect.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200 || signal.aborted) {
        socket.destroy();
        callback(new Error("WebSocket proxy tunnel refused"), undefined!);
        return;
      }
      if (head.length) socket.unshift(head);
      if (!secure) {
        callback(null, socket);
        return;
      }
      const tls = tlsConnect({
        socket,
        host: hostname,
        servername: isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: true,
      });
      const abort = addAbortListener(signal, () => {
        tls.destroy(new Error("WebSocket proxy connection cancelled"));
      });
      const dispose = () => {
        abort[Symbol.dispose]();
        tls.removeListener("secureConnect", dispose);
        tls.removeListener("close", dispose);
      };
      tls.once("secureConnect", dispose);
      tls.once("close", dispose);
      callback(null, tls);
    });
    connect.end();
    return undefined;
  };
}

export class ProxyTransport {
  readonly #http = new HttpAgent();
  readonly #https = new HttpsAgent({ rejectUnauthorized: true });
  readonly #direct = new Agent({ connect: { rejectUnauthorized: true } });
  readonly #lifetime = new AbortController();
  readonly #sockets = new Set<WebSocket>();
  #closing?: Promise<void>;
  readonly #unified: boolean;
  readonly #proxies: Record<TargetScheme, Endpoint | undefined>;
  readonly #dispatchers: Record<TargetScheme, ProxyAgent | undefined>;
  readonly #policy: ReturnType<typeof createProxyPolicy>;
  readonly dispatcher;

  constructor(
    settings: HostProxySettings,
    credentials: ProxyCredentials,
    trustedLanOrigins: readonly string[] | (() => readonly string[]),
  ) {
    const env = settings.mode === "inherit" ? snapshotEnvironmentProxy() : undefined;
    this.#unified = settings.mode === "manual" && settings.proxy.kind === "unified";
    this.#policy = createProxyPolicy({
      bypass: settings.mode === "manual" ? (settings.bypass ?? []) : [],
      environmentBypass: env?.noProxy,
      trustedLanOrigins,
    });
    if (settings.mode === "manual" && settings.proxy.kind === "unified") {
      const unified = endpoint(settings.proxy.url, credentials.unified);
      this.#proxies = { http: unified, https: unified };
    } else if (settings.mode === "manual" && settings.proxy.kind === "split") {
      this.#proxies = {
        http: endpoint(settings.proxy.httpUrl, credentials.http),
        https: endpoint(settings.proxy.httpsUrl, credentials.https),
      };
    } else {
      this.#proxies = {
        http: env && environmentEndpoint(env.httpProxy),
        https: env && environmentEndpoint(env.httpsProxy),
      };
    }
    const createDispatcher = (proxy?: Endpoint) =>
      proxy &&
      new ProxyAgent({
        uri: proxy.url,
        token: proxy.authorization,
        proxyTunnel: true,
        requestTls: { rejectUnauthorized: true },
        proxyTls: { rejectUnauthorized: true },
      });
    const http = createDispatcher(this.#proxies.http);
    this.#dispatchers = {
      http,
      https:
        this.#proxies.http === this.#proxies.https ? http : createDispatcher(this.#proxies.https),
    };
    this.dispatcher = this.#direct.compose((direct) => (options, handler) => {
      if (this.#lifetime.signal.aborted) throw new Error("Outbound proxy transport closed");
      const route = this.#policy(options.origin ?? "");
      const proxy = this.#dispatchers[route.target];
      return route.bypass || !proxy ? direct(options, handler) : proxy.dispatch(options, handler);
    });
  }

  webSocket(address: string | URL, signal?: AbortSignal): WebSocket {
    return this.#webSocket(address, signal);
  }

  /** Used only with fixed, source-owned diagnostic targets. Exercise each configured proxy even
   * when an outbound bypass rule would normally match the diagnostic origin. */
  diagnosticRoutes() {
    const routes = (["http", "https"] as const).filter(
      (route) => this.#proxies[route] || route === "https",
    );
    return (this.#unified ? (["https"] as const) : routes).map((route) => {
      const proxySlot = this.#unified ? "unified" : route;
      const targets = diagnosticTargets[route];
      const coverage: ProxyDiagnosticCoverage = {
        proxySlot: this.#proxies[route] ? proxySlot : null,
        checks: targets.checks,
      };
      return {
        coverage,
        upgrade: targets.upgrade,
        http: (signal: AbortSignal) =>
          fetch(targets.http, {
            dispatcher: this.#dispatchers[route] ?? this.#direct,
            method: "GET",
            signal,
            redirect: "manual",
          }),
        webSocket: (signal: AbortSignal) => this.#webSocket(targets.webSocket, signal, route),
      };
    });
  }

  #webSocket(
    address: string | URL,
    signal?: AbortSignal,
    diagnosticRoute?: TargetScheme,
  ): WebSocket {
    if (this.#lifetime.signal.aborted) throw new Error("Outbound proxy transport closed");
    const route = this.#policy(address);
    const url = new URL(address);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error("Unsupported WebSocket protocol");
    }
    const proxyScheme = diagnosticRoute ?? (route.bypass ? undefined : route.target);
    const proxy = proxyScheme && this.#proxies[proxyScheme];
    const handshake = new AbortController();
    const connectionSignal = AbortSignal.any([
      this.#lifetime.signal,
      handshake.signal,
      ...(signal ? [signal] : []),
    ]);
    const secure = route.target === "https";
    let agent = secure ? this.#https : this.#http;
    if (proxy) {
      agent = secure ? new HttpsAgent() : new HttpAgent();
      agent.createConnection = websocketProxyConnection(proxy, url, connectionSignal);
    }
    const options = {
      agent,
      followRedirects: false,
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
      maxPayload: 8 * 1024 * 1024,
      signal: connectionSignal,
    };
    const socket = new WebSocket(url, options);
    const deadline = setTimeout(() => handshake.abort(), 10_000).unref();
    this.#sockets.add(socket);
    socket.on("error", () => {});
    socket.once("open", () => clearTimeout(deadline));
    socket.once("close", () => {
      clearTimeout(deadline);
      handshake.abort();
      if (proxy) agent.destroy();
      this.#sockets.delete(socket);
    });
    return socket;
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#retire());
  }

  async #retire() {
    this.#lifetime.abort();
    const sockets = [...this.#sockets].map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.once("close", resolve);
          socket.terminate();
        }),
    );
    this.#http.destroy();
    this.#https.destroy();
    await Promise.allSettled([
      ...sockets,
      ...[...new Set([this.#direct, ...Object.values(this.#dispatchers)])].map((agent) =>
        agent?.destroy(),
      ),
    ]);
  }
}
