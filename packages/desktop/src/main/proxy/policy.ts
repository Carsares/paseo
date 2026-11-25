import { isIP } from "node:net";
import type { ProxyConfig } from "electron";
import { z } from "zod";
import {
  chromiumBypassRules,
  matchesBypass,
  normalizeBypassHost,
  parseBypassRule,
} from "./bypass.js";

export const desktopProxyScope = z.enum(["mainWindow", "browser", "updater"]);
export type DesktopProxyScope = z.infer<typeof desktopProxyScope>;

const safeHostname =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i;

function canonicalHostname(host: string): string | null {
  if (host.trim() !== host) return null;
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal) === 6) return URL.parse(`http://[${literal}]`)?.hostname ?? null;
  if (!safeHostname.test(host)) return null;
  return host.toLowerCase();
}

export const proxyUrl = z
  .string()
  .max(2048)
  .transform((value, ctx) => {
    const authority = /^https?:\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::([0-9]{1,5}))?$/i.exec(value);
    const url = authority?.[0] === value ? URL.parse(value) : null;
    if (!url || !canonicalHostname(url.hostname) || url.port === "0") {
      ctx.addIssue({
        code: "custom",
        message: "Enter an HTTP or HTTPS proxy URL with only a host and optional port.",
      });
      return z.NEVER;
    }
    return url.origin;
  });

const manualRoutes = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unified"), url: proxyUrl }),
  z.strictObject({ kind: z.literal("split"), http: proxyUrl, https: proxyUrl }),
]);

export const desktopProxyPolicy = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("system") }),
  z.strictObject({ mode: z.literal("direct") }),
  z.strictObject({
    mode: z.literal("manual"),
    routes: manualRoutes,
    bypass: z
      .array(
        z.string().refine((rule) => parseBypassRule(rule) !== null, "Invalid proxy bypass rule."),
      )
      .max(128)
      .optional(),
  }),
]);
export type DesktopProxyPolicy = z.infer<typeof desktopProxyPolicy>;

export const desktopProxySlots = ["unified", "http", "https"] as const;
export type DesktopProxySlot = (typeof desktopProxySlots)[number];

export function proxySlotsForPolicy(
  policy: DesktopProxyPolicy,
): Partial<Record<DesktopProxySlot, string>> {
  if (policy.mode !== "manual") return {};
  const { routes } = policy;
  if (routes.kind === "unified") return { unified: routes.url };
  return { http: routes.http, https: routes.https };
}

export interface ScopeRouting {
  // Trusted host inventory from pairing, never a renderer-provided Chromium bypass list.
  pairedLanHosts: readonly string[];
  // The caller routes all local control targets through a separate direct transport.
  independentDirectLan: boolean;
  // The binding guarantees HTTP(S)-only traffic when this is false.
  webSockets: boolean;
}

export function urlsForPolicy(policy: DesktopProxyPolicy): string[] {
  return [...new Set(Object.values(proxySlotsForPolicy(policy)))];
}

export function proxyForTarget(
  policy: DesktopProxyPolicy,
  target: URL,
  pairedLanHosts: readonly string[] = [],
): string | null {
  if (policy.mode !== "manual") return null;
  if (isProtectedProxyHost(target.hostname, pairedLanHosts)) return null;
  if (matchesBypass(parseBypass(policy), target)) return null;
  return configuredProxyForTarget(policy, target);
}

export function configuredProxyForTarget(
  policy: Extract<DesktopProxyPolicy, { mode: "manual" }>,
  target: URL,
): string {
  if (policy.routes.kind === "unified") return policy.routes.url;
  return target.protocol === "https:" || target.protocol === "wss:"
    ? policy.routes.https
    : policy.routes.http;
}

export function isProtectedProxyHost(hostname: string, pairedLanHosts: readonly string[]): boolean {
  const host = normalizeBypassHost(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127.")) ||
    pairedLanHosts.some((paired) => normalizeBypassHost(paired) === host)
  );
}

function parseBypass(policy: Extract<DesktopProxyPolicy, { mode: "manual" }>) {
  return (policy.bypass ?? []).map((value) => {
    const rule = parseBypassRule(value);
    if (!rule) throw new Error("Invalid proxy bypass rule.");
    return rule;
  });
}

export function proxyAddress(url: string): { host: string; port: number } {
  const endpoint = new URL(url);
  const host = endpoint.hostname;
  const defaultPort = endpoint.protocol === "https:" ? 443 : 80;
  return { host, port: endpoint.port ? Number(endpoint.port) : defaultPort };
}

export function chromiumProxyResult(url: string): string {
  const { host, port } = proxyAddress(url);
  const kind = new URL(url).protocol === "https:" ? "HTTPS" : "PROXY";
  return `${kind} ${host}:${port}`;
}

export function directLanHosts(routing: ScopeRouting): string[] {
  return [
    ...new Set(
      routing.pairedLanHosts.map((host) => {
        const canonical = canonicalHostname(host);
        if (!canonical) throw new Error("Invalid paired LAN hostname.");
        return canonical.replace(/\.$/, "");
      }),
    ),
  ];
}

function pairedHostRules(hosts: string[]): string[] {
  return hosts.flatMap((host) => {
    const literal = normalizeBypassHost(host);
    const family = isIP(literal);
    if (family === 4 || family === 6) {
      return chromiumBypassRules([{ kind: "host", host: literal, family, port: null }]);
    }
    return [host, `${host}.`];
  });
}

// Chromium's IPv4 CIDR also covers the equivalent mapped IPv6 addresses.
const protectedBypassRules = [
  "<-loopback>",
  "127.0.0.0/8",
  "[::1]",
  "localhost",
  "localhost.",
  "*.localhost",
  "*.localhost.",
];

export function chromiumConfig(policy: DesktopProxyPolicy, routing: ScopeRouting): ProxyConfig {
  const hosts = directLanHosts(routing);
  if (policy.mode === "system") {
    if (hosts.length && !routing.independentDirectLan) {
      throw new Error("System proxy requires independent direct transport for paired LAN hosts.");
    }
    return { mode: "system" };
  }
  if (policy.mode === "direct") return { mode: "direct" };

  const routes = policy.routes;
  const bypass = parseBypass(policy);
  const proxyBypassRules = [
    ...protectedBypassRules,
    ...pairedHostRules(hosts),
    ...chromiumBypassRules(bypass),
  ].join(",");
  if (routes.kind === "unified") {
    return { mode: "fixed_servers", proxyRules: routes.url, proxyBypassRules };
  }
  if (routing.webSockets && routes.http !== routes.https) {
    throw new Error(
      "Split proxy needs an HTTP(S)-only session because Chromium cannot split WebSocket routes.",
    );
  }
  if (routes.http === routes.https) {
    return { mode: "fixed_servers", proxyRules: routes.http, proxyBypassRules };
  }
  return {
    mode: "fixed_servers",
    proxyRules: `http=${routes.http};https=${routes.https}`,
    proxyBypassRules,
  };
}

export interface ProxyCredentials {
  username: string;
  password: string;
}

export interface ProxyAuthentication {
  isProxy: boolean;
  host: string;
  port: number;
}

export function matchingCredentials(
  credentials: ReadonlyMap<string, ProxyCredentials>,
  auth: ProxyAuthentication,
): ProxyCredentials | undefined {
  if (!auth.isProxy) return undefined;
  const host = canonicalHostname(auth.host);
  for (const [url, value] of credentials) {
    const endpoint = proxyAddress(url);
    if (endpoint.host === host && endpoint.port === auth.port) return value;
  }
  return undefined;
}
