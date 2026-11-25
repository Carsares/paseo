import { BlockList, isIP } from "node:net";

function ipHost(host: string): string {
  const raw = host.replace(/^\[|\]$/g, "");
  if (isIP(raw) !== 6) return raw;
  const canonical = new URL(`http://[${raw}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const hi = Number.parseInt(mapped[1]!, 16);
  const lo = Number.parseInt(mapped[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function target(url: string | URL) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid outbound URL");
  }
  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const webSocket = parsed.protocol === "ws:" || parsed.protocol === "wss:";
  if (!secure && !webSocket && parsed.protocol !== "http:") {
    throw new Error("Unsupported outbound protocol");
  }
  const hostname = parsed.hostname.toLowerCase();
  const host = ipHost(hostname.replace(/\.$/, ""));
  const port = Number(parsed.port || (secure ? 443 : 80));
  return { host, hostname, port, secure, webSocket };
}

type Target = ReturnType<typeof target>;
type Match = (target: Target) => boolean;

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

function inBlock(list: BlockList, host: string): boolean {
  const family = isIP(host);
  return family !== 0 && list.check(host, family === 4 ? "ipv4" : "ipv6");
}

function invalidRule() {
  return new Error("Invalid proxy bypass rule");
}

function parseSubnetRule(rule: string): Match {
  const [address, bits, extra] = rule.split("/");
  if (!address || !bits || extra !== undefined || !/^\d{1,3}$/.test(bits)) throw invalidRule();
  const raw = address.replace(/^\[(.*)\]$/, "$1");
  const originalFamily = isIP(raw);
  if (originalFamily === 0) throw invalidRule();
  const host = ipHost(raw);
  const family = isIP(host);
  const prefix = Number(bits) - (family === 4 && originalFamily === 6 ? 96 : 0);
  if (prefix < 0 || prefix > (family === 4 ? 32 : 128)) throw invalidRule();
  const list = new BlockList();
  list.addSubnet(host, prefix, family === 4 ? "ipv4" : "ipv6");
  return ({ host: candidate }) => isIP(candidate) === family && inBlock(list, candidate);
}

function parseHostRule(rule: string): Match {
  const bareV6 = isIP(rule) === 6;
  const parts = bareV6 ? undefined : /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(rule);
  if (!bareV6 && !parts) throw invalidRule();
  const port = parts?.[2] === undefined ? undefined : Number(parts[2]);
  if (port !== undefined && (port === 0 || port > 65535)) throw invalidRule();
  const name = (parts?.[1] ?? rule).replace(/^\*?\./, "").replace(/\.$/, "");
  if (!(name.startsWith("[") || bareV6 || /^[\p{L}\p{N}\p{M}._-]+$/u.test(name))) {
    throw invalidRule();
  }
  let host: string;
  try {
    host = target(`http://${bareV6 ? `[${name}]` : name}`).host;
  } catch {
    throw invalidRule();
  }
  const address = isIP(host) !== 0;
  return (candidate) =>
    (port === undefined || port === candidate.port) &&
    (candidate.host === host || (!address && candidate.host.endsWith(`.${host}`)));
}

function parseRule(rule: string): Match {
  if (rule === "*") return () => true;
  if (rule.length > 512 || !rule || /[\s\\@?#%,]/.test(rule)) throw invalidRule();
  return rule.includes("/") ? parseSubnetRule(rule) : parseHostRule(rule);
}

function environmentMatcher(noProxy: string): Match {
  const entries = noProxy
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean);
  if (entries.includes("*")) return () => true;
  // Match the legacy environment agents against the URL hostname as written by Node.
  // Manual rules add CIDR and other canonical forms. They never change NO_PROXY.
  const rules = entries.map((entry) => {
    const match = /^(.+):(\d+)$/.exec(entry);
    return {
      host: (match ? match[1]! : entry).replace(/^\*?\./, ""),
      port: match ? Number(match[2]) : undefined,
    };
  });
  return ({ hostname, port, secure, webSocket }) => {
    // The existing HTTP agent treats zero as an unspecified port.
    const targetPort = webSocket ? port : port || (secure ? 443 : 80);
    return rules.some((rule) => {
      if (rule.port !== undefined && (webSocket || rule.port !== 0) && rule.port !== targetPort) {
        return false;
      }
      return rule.host !== "" && (hostname === rule.host || hostname.endsWith(`.${rule.host}`));
    });
  };
}

export function validateProxyBypass(rules: readonly string[]): void {
  if (rules.length > 128) throw new Error("Too many proxy bypass rules");
  for (const rule of rules) parseRule(rule);
}

/** Automatic LAN bypass requires a trusted paired origin, including its protocol and port. */
export function createProxyPolicy(options: {
  bypass: readonly string[];
  environmentBypass?: string;
  trustedLanOrigins?: readonly string[] | (() => readonly string[]);
}) {
  const rules = options.bypass.map(parseRule);
  const matchesEnvironment = environmentMatcher(options.environmentBypass ?? "");
  const originKey = ({ host, port, secure }: Target) => JSON.stringify([host, port, secure]);
  const trusted = options.trustedLanOrigins;
  const originSet = (origins?: readonly string[]) =>
    new Set(origins?.map((origin) => originKey(target(origin))));
  const fixed = typeof trusted === "function" ? undefined : originSet(trusted);
  let cachedOrigins: readonly string[] | undefined;
  let cachedKeys = new Set<string>();
  const trustedLan = (candidate: Target) => {
    if (typeof trusted === "function") {
      const origins = trusted();
      if (origins !== cachedOrigins) {
        cachedOrigins = origins;
        cachedKeys = originSet(origins);
      }
    }
    return (fixed ?? cachedKeys).has(originKey(candidate));
  };
  return (address: string | URL) => {
    const candidate = target(address);
    const { host, secure } = candidate;
    return {
      target: secure ? ("https" as const) : ("http" as const),
      bypass:
        host === "localhost" ||
        host.endsWith(".localhost") ||
        inBlock(loopback, host) ||
        trustedLan(candidate) ||
        matchesEnvironment(candidate) ||
        rules.some((matches) => matches(candidate)),
    };
  };
}
