import { BlockList, isIP } from "node:net";

type AddressFamily = 4 | 6;

function addressFamily(host: string): 0 | AddressFamily {
  const family = isIP(host);
  return family === 4 || family === 6 ? family : 0;
}

export type BypassRule =
  | { kind: "all" }
  | { kind: "host"; host: string; family: 0 | AddressFamily; port: number | null }
  | { kind: "subnet"; address: string; family: AddressFamily; prefix: number };

export function parseBypassRule(value: string): BypassRule | null {
  if (value === "*") return { kind: "all" };
  if (!value || value.length > 512 || /[\s\\@?#%,;]/u.test(value)) return null;
  return value.includes("/") ? parseSubnet(value) : parseHost(value);
}

function parseSubnet(value: string): BypassRule | null {
  const parts = /^(\[[a-f\d:.]+\]|[a-f\d:.]+)\/(\d{1,3})$/iu.exec(value);
  if (!parts) return null;
  const raw = parts[1].replace(/^\[|\]$/g, "");
  const rawFamily = addressFamily(raw);
  if (!rawFamily || (rawFamily === 4 && parts[1] !== raw)) return null;
  const address = rawFamily === 6 ? canonicalIpV6(raw) : raw;
  if (!address) return null;
  const family = addressFamily(address);
  const prefix = Number(parts[2]) - (rawFamily === 6 && family === 4 ? 96 : 0);
  if (!family || prefix < 0 || prefix > (family === 4 ? 32 : 128)) return null;
  return { kind: "subnet", address, family, prefix };
}

function parseHost(value: string): BypassRule | null {
  const bareV6 = isIP(value) === 6;
  if (bareV6) {
    const host = canonicalIpV6(value);
    return host ? { kind: "host", host, family: addressFamily(host), port: null } : null;
  }
  const parts = /^(\[[a-f\d:.]+\]|(?:\*?\.)?[\p{L}\p{N}\p{M}._-]+)(?::(\d{1,5}))?$/iu.exec(value);
  if (!parts) return null;
  const port = parts[2] ? Number(parts[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  const input = parts[1].replace(/^\*?\./u, "").replace(/\.$/u, "");
  const canonical = URL.parse("http://" + input)?.hostname;
  if (!canonical) return null;
  const host = normalizeBypassHost(canonical);
  const family = addressFamily(host);
  if (!family && !/^[a-z\d._-]+$/i.test(host)) return null;
  return { kind: "host", host, family, port };
}

function canonicalIpV6(address: string): string | null {
  const host = URL.parse("http://[" + address + "]")?.hostname;
  return host ? normalizeBypassHost(host) : null;
}

export function normalizeBypassHost(host: string): string {
  const plain = host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(plain);
  if (!mapped) return plain;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function inSubnet(host: string, address: string, prefix: number): boolean {
  const family = isIP(address) === 4 ? "ipv4" : "ipv6";
  const network = new BlockList();
  network.addSubnet(address, prefix, family);
  return network.check(host, family);
}

export function matchesBypass(rules: BypassRule[], target: URL): boolean {
  const host = normalizeBypassHost(target.hostname);
  const family = isIP(host);
  const secure = target.protocol === "https:" || target.protocol === "wss:";
  const port = Number(target.port || (secure ? 443 : 80));
  return rules.some((rule) => {
    if (rule.kind === "all") return true;
    if (rule.kind === "subnet") {
      return family === rule.family && inSubnet(host, rule.address, rule.prefix);
    }
    if (rule.port !== null && rule.port !== port) return false;
    return host === rule.host || (rule.family === 0 && host.endsWith("." + rule.host));
  });
}

function chromiumSubnetRules(rule: Extract<BypassRule, { kind: "subnet" }>): string[] {
  const mapped = "::ffff:0:0";
  if (rule.family !== 6 || rule.prefix >= 96 || !inSubnet(mapped, rule.address, rule.prefix)) {
    return [rule.address + "/" + rule.prefix];
  }
  // Chromium promotes IPv4 literals to mapped IPv6 for IPv6 CIDRs. Express
  // the sibling prefixes of the excluded mapped IPv4 range instead.
  const prefixes: string[] = [];
  for (let bit = rule.prefix; bit < 96; bit++) {
    const words = [0, 0, 0, 0, 0, 0xffff, 0, 0];
    words[Math.floor(bit / 16)] ^= 1 << (15 - (bit % 16));
    prefixes.push(words.map((word) => word.toString(16)).join(":") + "/" + (bit + 1));
  }
  return prefixes;
}

export function chromiumBypassRules(rules: BypassRule[]): string[] {
  const normalized = rules.flatMap((rule) => {
    if (rule.kind === "all") return ["*"];
    if (rule.kind === "subnet") return chromiumSubnetRules(rule);
    const suffix = rule.port === null ? "" : ":" + rule.port;
    if (rule.family === 6) return ["[" + rule.host + "]" + suffix];
    if (rule.family === 4) {
      return [rule.host + suffix, "[::ffff:" + rule.host + "]" + suffix];
    }
    const forms = [rule.host, rule.host + ".", "*." + rule.host, "*." + rule.host + "."];
    return forms.map((host) => host + suffix);
  });
  return [...new Set(normalized)];
}
