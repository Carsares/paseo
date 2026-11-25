import type { ProxyConfig, Session } from "electron";
import type { DesktopProxyScopePort, ProxyPlan } from "./desktop-proxy.js";
import { chromiumRoute } from "./native-control.js";
import {
  chromiumProxyResult,
  configuredProxyForTarget,
  directLanHosts,
  isProtectedProxyHost,
  proxyForTarget,
  type ProxyCredentials,
  type ScopeRouting,
} from "./policy.js";

type ProxySession = Pick<
  Session,
  "setProxy" | "forceReloadProxyConfig" | "resolveProxy" | "closeAllConnections" | "clearAuthCache"
>;

interface SessionProxyOptions<T extends ProxySession> {
  target: T;
  baseline: ProxyConfig;
  routing: ScopeRouting;
  probes: readonly URL[];
  createCandidate(): T;
  probe(
    session: T,
    url: URL,
    credentials: ReadonlyMap<string, ProxyCredentials>,
    signal: AbortSignal,
  ): Promise<void>;
  pauseRequests(routingOnly: boolean): () => void;
  onApplied?(plan: ProxyPlan | null): void;
  liveConfig?(plan: ProxyPlan): LiveProxyConfig;
  isolate(): void;
  timeoutMs?: number;
}

export interface LiveProxyConfig {
  config: ProxyConfig;
  control: ReadonlyMap<string, string>;
  paired: ReadonlySet<string>;
  verificationRoutes?: ReadonlyMap<string, string>;
}

class ProxyTimeout extends Error {}

function deadline<T>(
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ProxyTimeout("Desktop proxy operation timed out.");
      controller.abort(error);
      reject(error);
    }, milliseconds);
  });
  const pending = Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

async function configure(session: ProxySession, config: ProxyConfig, signal: AbortSignal) {
  signal.throwIfAborted();
  await session.setProxy(config);
  signal.throwIfAborted();
  await session.forceReloadProxyConfig();
}

async function clearConnections(session: ProxySession) {
  const closed = await Promise.allSettled([
    Promise.resolve().then(() => session.closeAllConnections()),
    Promise.resolve().then(() => session.clearAuthCache()),
  ]);
  // Closing requests can race with completing an authentication response.
  if (closed.every(({ status }) => status === "fulfilled")) {
    await session.clearAuthCache();
  } else {
    throw new Error("Could not clean the desktop proxy session.");
  }
}

function routeTargets(
  routing: Pick<ScopeRouting, "pairedLanHosts" | "webSockets">,
  probes: readonly URL[],
  skipImplicitLinkLocal = false,
): URL[] {
  const urls = [
    "http://localhost./",
    "https://app.localhost/",
    "http://127.31.2.3/",
    "https://[::ffff:127.1.2.3]/",
    "http://[::1]/",
  ];
  if (!skipImplicitLinkLocal) urls.push("http://169.254.23.4/", "https://[fe80::1]/");
  for (const host of routing.pairedLanHosts) urls.push(`http://${host}/`, `https://${host}/`);
  urls.push(...probes.map((probe) => probe.href));
  if (routing.webSockets) {
    urls.push(...urls.map((url) => url.replace(/^http(s?):/, "ws$1:")));
  }
  return urls.map((url) => new URL(url));
}

async function readRoutes(session: ProxySession, targets: readonly URL[], signal: AbortSignal) {
  const routes: string[] = [];
  for (const url of targets) {
    signal.throwIfAborted();
    routes.push(chromiumRoute(await session.resolveProxy(url.href)));
  }
  return routes;
}

function checkRoutes(actual: string[], expected: string[]) {
  if (actual.some((route, index) => route !== chromiumRoute(expected[index]))) {
    throw new Error("Chromium did not select the expected desktop proxy route.");
  }
}

async function runCandidate<T extends ProxySession>(
  options: SessionProxyOptions<T>,
  current: T,
  plan: ProxyPlan,
  signal: AbortSignal,
) {
  await configure(current, plan.config, signal);
  const targets = routeTargets(plan, options.probes);
  const routes = await readRoutes(current, targets, signal);
  const policy = plan.policy;
  if (policy.mode !== "system") {
    checkRoutes(
      routes,
      targets.map((target) => expectedRoute(plan, target)),
    );
  }
  for (const url of options.probes) {
    signal.throwIfAborted();
    if (policy.mode !== "manual") {
      await options.probe(current, url, new Map(), signal);
      continue;
    }
    if (isProtectedProxyHost(url.hostname, plan.pairedLanHosts)) {
      throw new Error("Desktop proxy test target must be outside protected local routes.");
    }
    const endpoint = configuredProxyForTarget(policy, url);
    await configure(
      current,
      { mode: "fixed_servers", proxyRules: endpoint, proxyBypassRules: "<-loopback>" },
      signal,
    );
    const resolved = await readRoutes(current, [url], signal);
    checkRoutes(resolved, [chromiumProxyResult(endpoint)]);
    const credentials = new Map<string, ProxyCredentials>();
    const value = plan.credentials.get(endpoint);
    if (value) credentials.set(endpoint, value);
    await options.probe(current, url, credentials, signal);
    signal.throwIfAborted();
    await clearConnections(current);
  }
  return routes;
}

function expectedRoute(plan: ProxyPlan, target: URL): string {
  const proxy = proxyForTarget(plan.policy, target, plan.pairedLanHosts);
  return proxy ? chromiumProxyResult(proxy) : "DIRECT";
}

export function createSessionProxyPort<T extends ProxySession>(
  options: SessionProxyOptions<T>,
): DesktopProxyScopePort {
  const { target, baseline, routing, probes, timeoutMs = 8_000 } = options;
  const initialTargets = routeTargets(
    { ...routing, pairedLanHosts: directLanHosts(routing) },
    probes,
  );
  const systemRoutes = new WeakMap<ProxyPlan, string[]>();
  let baselineRoutes: string[] | undefined;
  let disposable: T | undefined;
  let tainted = false;
  let isolated = false;
  let resumeRequests: (() => void) | undefined;
  let readyToResume = false;

  async function isolatedWork<U>(
    operation: (candidate: T, signal: AbortSignal) => Promise<U>,
  ): Promise<U> {
    const candidate = disposable ?? options.createCandidate();
    disposable = undefined;
    let result: U;
    try {
      result = await deadline(timeoutMs, (signal) => operation(candidate, signal));
    } finally {
      await deadline(timeoutMs, () => clearConnections(candidate));
    }
    disposable = candidate;
    return result;
  }

  async function applyPlan(plan: ProxyPlan | null, signal: AbortSignal, routingOnly: boolean) {
    baselineRoutes ??= await readRoutes(target, initialTargets, signal);
    const live = plan && options.liveConfig?.(plan);
    signal.throwIfAborted();
    if (!routingOnly) await clearConnections(target);
    await configure(target, live?.config ?? plan?.config ?? baseline, signal);
    signal.throwIfAborted();
    if (!routingOnly) await clearConnections(target);
    if (!plan) {
      checkRoutes(await readRoutes(target, initialTargets, signal), baselineRoutes);
      return;
    }
    // The request gate checks the expected HTTP route, and rejects implicit
    // link-local DIRECT if neither protection nor user bypass permits it.
    const targets = routeTargets(plan, probes, live?.config.mode === "pac_script");
    let expected = targets.map((url) =>
      live?.paired.has(url.origin) ? "DIRECT" : expectedRoute(plan, url),
    );
    if (plan.policy.mode === "system") {
      const verified = systemRoutes.get(plan);
      expected =
        verified ??
        (await isolatedWork(async (candidate, candidateSignal) => {
          await configure(candidate, plan.config, candidateSignal);
          return readRoutes(candidate, targets, candidateSignal);
        }));
      systemRoutes.set(plan, expected);
    }
    checkRoutes(await readRoutes(target, targets, signal), expected);
    if (live) await verifyLiveRoutes(live, signal);
  }

  async function verifyLiveRoutes(live: LiveProxyConfig, signal: AbortSignal) {
    const routes = new Map(live.verificationRoutes);
    for (const [origin, route] of live.control) routes.set(origin + "/ws", route);
    for (const origin of live.paired) routes.set(origin, "DIRECT");
    checkRoutes(
      await readRoutes(
        target,
        [...routes.keys()].map((url) => new URL(url)),
        signal,
      ),
      [...routes.values()],
    );
  }

  return {
    routing,
    async test(plan) {
      if (plan.policy.mode === "manual") options.liveConfig?.(plan);
      const routes = await isolatedWork((candidate, signal) =>
        runCandidate(options, candidate, plan, signal),
      );
      if (plan.policy.mode === "system") systemRoutes.set(plan, routes);
    },
    async apply(plan, routingOnly = false) {
      if (tainted) throw new Error("Desktop proxy session needs isolation.");
      readyToResume = false;
      resumeRequests ??= options.pauseRequests(routingOnly);
      try {
        await deadline(timeoutMs, (signal) => applyPlan(plan, signal, routingOnly));
        options.onApplied?.(plan);
        readyToResume = true;
      } catch (error) {
        if (error instanceof ProxyTimeout) tainted = true;
        throw error;
      }
    },
    resume() {
      if (!readyToResume || !resumeRequests || tainted) {
        throw new Error("Desktop proxy session cannot resume without a verified route.");
      }
      resumeRequests();
      resumeRequests = undefined;
    },
    isolate() {
      if (isolated) return;
      isolated = true;
      tainted = true;
      resumeRequests = undefined;
      options.isolate();
      void deadline(timeoutMs, () => clearConnections(target)).catch(() => undefined);
    },
  };
}
