import { randomUUID } from "node:crypto";
import {
  app,
  net,
  safeStorage,
  session,
  type AuthInfo,
  type AuthenticationResponseDetails,
  type Event,
  type ProxyConfig,
  type Session,
  type WebContents,
} from "electron";
import { createDesktopProxy, type DesktopProxyScopePort, type ProxyPlan } from "./desktop-proxy.js";
import {
  desktopProxyScope,
  matchingCredentials,
  type DesktopProxyPolicy,
  type ProxyCredentials,
  type DesktopProxyScope,
  type ScopeRouting,
} from "./policy.js";
import { proxyStore, proxyVault } from "./storage.js";
import { createSessionProxyPort, type LiveProxyConfig } from "./session-proxy.js";

export const DESKTOP_PROXY_COVERAGE = {
  mainWindow: "Chromium HTTP(S), plus WebSockets when the binding allows them",
  browser: "Chromium HTTP(S) and WebSocket requests from the bound webview session",
  updater: "electron-updater HTTP(S) requests from its bound netSession",
  split: "HTTP(S)-only bindings with independent control transport",
  independent: [
    "control transport",
    "Unix sockets",
    "Windows named pipes",
    "SSH",
    "native update handoff",
  ],
} as const;

interface ElectronScope {
  session: Session;
  // Electron cannot unset a session override. Supply the existing restorable
  // config, including launch-specific overrides, to opt this session in.
  baseline: ProxyConfig;
  pairedLanHosts: readonly string[];
  independentDirectLan: boolean;
  probeUrls: { http: string; https: string };
  // A pause rejects new requests and retires already upgraded streams owned
  // by the affected scope. Isolation permanently retires the bound Session,
  // even when a native operation has timed out.
  pauseRequests(routingOnly: boolean): () => void;
  isolate(): void;
  onPolicyApplied?(policy: DesktopProxyPolicy | null, controlRecovery: boolean): void;
  liveConfig?(plan: ProxyPlan): LiveProxyConfig;
}

interface ElectronDesktopProxyOptions {
  settingsFile: string;
  // Bind only opted-in scopes. Main-window control traffic must already have
  // its existing independent route, before applying any session-wide override.
  scopes: {
    mainWindow?: ElectronScope & { controlRoutes: "independent"; webSockets?: "disabled" };
    browser?: ElectronScope;
    updater?: ElectronScope;
  };
}

type LoginCallback = (username?: string, password?: string) => void;

function checkTarget(target: string, scheme: "http:" | "https:"): URL {
  const url = URL.parse(target);
  if (!url || url.protocol !== scheme || url.username || url.password || url.hash) {
    throw new Error("Invalid desktop proxy connection check URL.");
  }
  return url;
}

function checkConnection(
  candidate: Session,
  url: URL,
  credentials: ReadonlyMap<string, ProxyCredentials>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = net.request({
      url: url.href,
      method: "HEAD",
      session: candidate,
      useSessionCookies: false,
      bypassCustomProtocolHandlers: true,
      redirect: "error",
    });
    function abort() {
      request.abort();
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
    let attempted = false;
    request.on("login", (auth, reply) => {
      const value = attempted ? undefined : matchingCredentials(credentials, auth);
      attempted = true;
      if (value && !signal.aborted) reply(value.username, value.password);
      else reply();
    });
    request.once("response", (response) => {
      signal.removeEventListener("abort", abort);
      response.on("error", () => undefined);
      response.on("data", () => undefined);
      if (response.statusCode >= 200 && response.statusCode < 300) resolve();
      else reject(new Error("Desktop proxy connection check was rejected."));
    });
    request.once("error", () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("Desktop proxy connection check failed."));
    });
    try {
      request.end();
    } catch (error) {
      signal.removeEventListener("abort", abort);
      request.abort();
      reject(error);
    }
  });
}

export async function createElectronDesktopProxy(options: ElectronDesktopProxyOptions) {
  const scopes: Partial<Record<DesktopProxyScope, DesktopProxyScopePort>> = {};
  const livePlans = new Map<Session, ProxyPlan>();
  const boundSessions = new Set<Session>();

  for (const scope of desktopProxyScope.options) {
    const binding = options.scopes[scope];
    if (!binding) continue;
    if (boundSessions.has(binding.session))
      throw new Error("Desktop proxy scopes require distinct sessions.");
    const mainWindow = options.scopes.mainWindow;
    if (scope === "mainWindow" && mainWindow?.controlRoutes !== "independent") {
      throw new Error("Main-window proxy requires an independent control transport.");
    }
    boundSessions.add(binding.session);
    const routing: ScopeRouting = {
      pairedLanHosts: [...binding.pairedLanHosts],
      independentDirectLan: binding.independentDirectLan,
      webSockets:
        scope !== "updater" && (scope !== "mainWindow" || mainWindow?.webSockets !== "disabled"),
    };
    const probes = [
      checkTarget(binding.probeUrls.http, "http:"),
      checkTarget(binding.probeUrls.https, "https:"),
    ];
    const target = binding.session;
    const port = createSessionProxyPort({
      routing,
      probes,
      target,
      baseline: binding.baseline,
      createCandidate: () =>
        session.fromPartition("paseo-proxy-candidate-" + randomUUID(), { cache: false }),
      probe: checkConnection,
      isolate: () => binding.isolate(),
      pauseRequests: (routingOnly) => binding.pauseRequests(routingOnly),
      ...(binding.liveConfig && { liveConfig: binding.liveConfig }),
      onApplied(plan) {
        if (plan) livePlans.set(target, plan);
        binding.onPolicyApplied?.(plan?.policy ?? null, plan?.controlRecovery === true);
      },
    });
    scopes[scope] = {
      ...port,
      async apply(plan, routingOnly) {
        livePlans.delete(target);
        await port.apply(plan, routingOnly);
      },
      isolate() {
        livePlans.delete(target);
        port.isolate();
      },
    };
  }

  // Electron supplies the originating session only for webContents-backed login.
  const removeWindowLogin = installWindowLogin(livePlans);
  const desktopProxy = await createDesktopProxy({
    scopes,
    store: proxyStore(options.settingsFile),
    vault: proxyVault(safeStorage, process.platform),
  }).catch((error: unknown) => {
    removeWindowLogin();
    throw error;
  });

  function answerUpdaterLogin(source: Session, auth: AuthInfo, reply: LoginCallback): void {
    const bound = options.scopes.updater;
    if (!bound || bound.session !== source) return;
    const plan = livePlans.get(source);
    if (!plan) return;
    const credentials = matchingCredentials(plan.credentials, auth);
    if (credentials) reply(credentials.username, credentials.password);
    else if (auth.isProxy) reply();
  }
  return { ...desktopProxy, answerUpdaterLogin, removeWindowLogin };
}

function installWindowLogin(livePlans: ReadonlyMap<Session, ProxyPlan>) {
  function onLogin(
    event: Event,
    contents: WebContents | null,
    details: AuthenticationResponseDetails,
    auth: AuthInfo,
    reply: LoginCallback,
  ) {
    if (!contents || !details.firstAuthAttempt) return;
    const url = URL.parse(details.url);
    if (url?.protocol !== "http:" && url?.protocol !== "https:") return;
    const plan = livePlans.get(contents.session);
    if (!plan) return;
    const credentials = matchingCredentials(plan.credentials, auth);
    if (!credentials) return;
    event.preventDefault();
    reply(credentials.username, credentials.password);
  }
  app.on("login", onLogin);
  return () => app.off("login", onLogin);
}
