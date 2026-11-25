import { BlockList, isIP } from "node:net";
import { normalizeBypassHost } from "./bypass.js";

const lan = new BlockList();
lan.addSubnet("10.0.0.0", 8);
lan.addSubnet("172.16.0.0", 12);
lan.addSubnet("192.168.0.0", 16);
lan.addSubnet("169.254.0.0", 16);
lan.addSubnet("127.0.0.0", 8);
lan.addSubnet("fc00::", 7, "ipv6");
lan.addSubnet("fe80::", 10, "ipv6");
lan.addAddress("::1", "ipv6");

export function pairedLanOrigin(raw: string): string | null {
  const authority = /^https?:\/\/(\[[a-f\d:.]+\]|[a-z\d.-]+)(?::\d{1,5})?\/?$/i.exec(raw);
  const url = authority?.[0] === raw ? URL.parse(raw) : null;
  if (!url || !authority || url.port === "0") return null;
  const host = normalizeBypassHost(url.hostname);
  if (host === "localhost") return url.origin;
  const family = isIP(host);
  if (family === 4 && isIP(url.hostname) === 4 && host !== authority[1]) return null;
  return family && lan.check(host, family === 4 ? "ipv4" : "ipv6") ? url.origin : null;
}
