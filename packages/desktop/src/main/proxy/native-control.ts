import type { ProxyConfig, Session, WebFrameMain } from "electron";
import { DesktopControlProxyConflict, type ProxyPlan } from "./desktop-proxy.js";
import { normalizeBypassHost, parseBypassRule } from "./bypass.js";
import { chromiumProxyResult, matchingCredentials } from "./policy.js";

export function parseControlSocketTarget(raw: string): URL | null {
  if (/\p{Cc}/u.test(raw)) return null;
  if (!/^wss?:\/\/[^\s/@?#\\]+\/ws(?:\?[^\s#\\]+)?$/u.test(raw)) return null;
  const url = URL.parse(raw);
  if (!url?.hostname || url.port === "0" || url.pathname !== "/ws") return null;
  if (!url.search) return url;
  const { searchParams: query } = url;
  const server = query.get("serverId");
  const version = query.get("v");
  if (
    query.size !== 3 ||
    !server ||
    server.length > 512 ||
    /\p{Cc}/u.test(server) ||
    query.get("role") !== "client" ||
    (version !== "1" && version !== "2")
  )
    return null;
  return url;
}

const leaseMs = 20_000;
const resolutionMs = 5_000;
const maxRoutes = 256;
const maxRoutesPerFrame = 32;
const noRoute = "PROXY 127.0.0.1:1";
const routeEntry =
  /^(?:PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5|QUIC) ([a-z\d._-]+|\[[a-f\d:.]+\]):([1-9]\d{0,4})$/i;

// Serialize only Chromium's proxy result grammar, never free-form PAC source.
function proxyChain(value: string): string {
  const entries = value.split(";").map((entry) => entry.trim());
  if (
    entries.length > 32 ||
    entries.some((entry) => {
      if (entry === "DIRECT") return false;
      const port = routeEntry.exec(entry)?.[2];
      return !port || Number(port) > 65535;
    })
  ) {
    throw new Error("Unsupported system route for desktop control connection.");
  }
  return entries.join("; ");
}

function originKey(url: URL) {
  return `${url.protocol}//${url.host}`;
}

function frameOrigin(frame: WebFrameMain): string | undefined {
  const url = URL.parse(frame.url);
  if (url && !url.username && !url.password) return originKey(url);
  return undefined;
}

const pacSource = String.raw`
function FindProxyForURL(url, host) {
  var parts = /^([a-z]+:)\/\/(\[[^\]]+\]|[^\/:]+)(?::(\d+))?/.exec(url);
  if (!parts) return config.noRoute;
  var scheme = parts[1];
  var secure = scheme === 'https:' || scheme === 'wss:';
  var port = Number(parts[3] || (secure ? 443 : 80));
  var name = parts[2].toLowerCase();
  if (scheme === 'ws:' || scheme === 'wss:') {
    var key = scheme + '//' + name + (parts[3] ? ':' + port : '');
    return config.control[key] || config.noRoute;
  }
  if (config.direct) return 'DIRECT';
  var httpOrigin = scheme + '//' + name + (parts[3] ? ':' + port : '');
  if (config.paired.indexOf(httpOrigin) >= 0) return 'DIRECT';
  name = name.replace(/\.$/, '').replace(/^\[|\]$/g, '');
  var mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(name);
  if (mapped) {
    var high = parseInt(mapped[1], 16);
    var low = parseInt(mapped[2], 16);
    name = [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  var family = name.indexOf(':') >= 0 ? 6 : (/^\d+(?:\.\d+){3}$/.test(name) ? 4 : 0);
  if (name === 'localhost' || /\.localhost$/.test(name) || name === '::1' ||
      (family === 4 && name.indexOf('127.') === 0) || config.local.indexOf(name) >= 0) return 'DIRECT';
  for (var i = 0; i < config.bypass.length; i++) {
    var rule = config.bypass[i];
    if (rule.kind === 'all') return 'DIRECT';
    if (rule.kind === 'subnet' && family === rule.family &&
        isInNetEx(name, rule.address + '/' + rule.prefix)) return 'DIRECT';
    if (rule.kind === 'host' && (rule.port === null || port === rule.port) &&
        (name === rule.host || (!rule.family && name.slice(-rule.host.length - 1) === '.' + rule.host))) return 'DIRECT';
  }
  return secure ? config.https : config.http;
}
`;

export function nativeControlPac(
  plan: ProxyPlan,
  control: ReadonlyMap<string, string>,
  paired: ReadonlySet<string> = new Set(),
): ProxyConfig {
  const { policy } = plan;
  if (policy.mode === "system" || (!control.size && (!paired.size || policy.mode === "direct"))) {
    return plan.config;
  }
  const direct = policy.mode === "direct";
  const routes = direct ? undefined : policy.routes;
  const config = {
    control: Object.fromEntries(control),
    paired: [...paired],
    direct,
    noRoute,
    local: plan.pairedLanHosts.map(normalizeBypassHost),
    bypass: direct ? [] : (policy.bypass ?? []).map(parseBypassRule).filter(Boolean),
    http: routes
      ? chromiumProxyResult(routes.kind === "split" ? routes.http : routes.url)
      : "DIRECT",
    https: routes
      ? chromiumProxyResult(routes.kind === "split" ? routes.https : routes.url)
      : "DIRECT",
  };
  return {
    mode: "pac_script",
    pacScript:
      "data:application/x-ns-proxy-autoconfig;base64," +
      Buffer.from(`var config = ${JSON.stringify(config)};\n${pacSource}`).toString("base64"),
  };
}

interface Registration {
  frame: WebFrameMain;
  origin: string;
  route: string;
  url: URL;
  expiresAt: number;
  requestId?: number;
}

export function createNativeControlRoutes(baseline: Pick<Session, "resolveProxy">) {
  let registrations: Registration[] = [];
  // Keep system proxy chains for save validation after a handshake lease ends.
  // These records contain no target URL and never authorize a request.
  const knownRoutes = new Set<string>();
  const frameChanges = new WeakMap<WebFrameMain, object>();

  function frameIsActive(item: Registration) {
    return !item.frame.detached && frameOrigin(item.frame) === item.origin;
  }

  function prune() {
    const now = performance.now();
    registrations = registrations.filter((item) => item.expiresAt > now && frameIsActive(item));
  }

  return {
    stage(frame: WebFrameMain, url: URL) {
      const origin = frameOrigin(frame);
      const frameChange = frameChanges.get(frame);
      return async () => {
        const route = proxyChain(await resolveRoute(baseline, url.href));
        prune();
        const key = originKey(url);
        if (
          !origin ||
          frame.detached ||
          frameOrigin(frame) !== origin ||
          frameChanges.get(frame) !== frameChange ||
          registrations.length >= maxRoutes ||
          registrations.filter((entry) => entry.frame === frame).length >= maxRoutesPerFrame ||
          registrations.some((entry) => originKey(entry.url) === key && entry.route !== route)
        ) {
          throw new Error("Desktop control route is unavailable.");
        }
        if (route !== "DIRECT" && knownRoutes.size < maxRoutes) knownRoutes.add(route);
        const registration = { frame, origin, url, route, expiresAt: performance.now() + leaseMs };
        registrations.push(registration);
        return () => {
          registrations = registrations.filter((entry) => entry !== registration);
        };
      };
    },
    routes(plan: ProxyPlan) {
      prune();
      if (plan.credentials.size) {
        for (const route of [...knownRoutes, ...registrations.map((entry) => entry.route)]) {
          if (
            route.split("; ").some((entry) => {
              const endpoint = routeEntry.exec(entry);
              return (
                endpoint &&
                matchingCredentials(plan.credentials, {
                  isProxy: true,
                  host: endpoint[1],
                  port: Number(endpoint[2]),
                })
              );
            })
          ) {
            throw new DesktopControlProxyConflict();
          }
        }
      }
      return new Map(registrations.map(({ url, route }) => [originKey(url), route]));
    },
    verificationRoutes() {
      prune();
      return new Map(registrations.map(({ url, route }) => [url.href, route]));
    },
    authorize(
      request: { id: number; url: string; frame?: WebFrameMain | null },
      phase: "begin" | "send",
    ) {
      prune();
      const registration = registrations.find(
        (item) =>
          item.url.href === request.url &&
          item.frame === request.frame &&
          (phase === "begin" ? item.requestId === undefined : item.requestId === request.id),
      );
      if (!registration) return null;
      registration.requestId = request.id;
      return registration.route;
    },
    forget(id: number) {
      registrations = registrations.filter((entry) => entry.requestId !== id);
    },
    releaseFrame(frame: WebFrameMain) {
      frameChanges.set(frame, {});
      registrations = registrations.filter((entry) => entry.frame !== frame);
    },
  };
}

export async function resolveRoute(session: Pick<Session, "resolveProxy">, url: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      session.resolveProxy(url),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Desktop proxy resolution timed out.")),
          resolutionMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
