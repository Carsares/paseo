import { readFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { HostSummarySchema, type HostDirectory } from "@getpaseo/protocol/hosts";
import { z } from "zod";

const SavedHostsSchema = z.array(HostSummarySchema.extend({ connection: z.string() }));

interface ConfirmedPeer {
  serverId: string;
  origin: string;
  lastOnlineAt: string;
}

export type ConfirmedLanPeers = ReadonlyMap<string, ConfirmedPeer>;

const privateIp = new BlockList();
privateIp.addSubnet("10.0.0.0", 8, "ipv4");
privateIp.addSubnet("172.16.0.0", 12, "ipv4");
privateIp.addSubnet("192.168.0.0", 16, "ipv4");
privateIp.addSubnet("169.254.0.0", 16, "ipv4");
privateIp.addSubnet("fc00::", 7, "ipv6");
privateIp.addSubnet("fe80::", 10, "ipv6");

function pairedLanOrigin(connection: string, description: string): string | undefined {
  try {
    const target = parseHostTarget(connection);
    if (
      target.kind !== "socket" ||
      target.offer ||
      target.socketPath ||
      target.description !== description
    )
      return;
    const url = new URL(target.url);
    const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const family = isIP(host);
    if (family === 4 && privateIp.check(host, "ipv4")) return url.origin;
    if (family === 6 && privateIp.check(host, "ipv6")) return url.origin;
  } catch {
    // An invalid or untrusted entry grants no bypass.
  }
}

export async function readConfirmedLanPeers(
  home: string,
  directory: HostDirectory,
  previous: ConfirmedLanPeers,
): Promise<ConfirmedLanPeers> {
  const registered = new Map(directory.hosts.map((host) => [host.registrationId, host]));
  const confirmed = new Map<string, ConfirmedPeer>();
  if (!registered.size) return confirmed;
  // The saved row contains the scheme omitted by the public TCP summary.
  const saved = SavedHostsSchema.parse(
    JSON.parse(await readFile(join(home, "hosts.json"), "utf8")),
  );
  for (const row of saved) {
    const host = registered.get(row.registrationId);
    if (
      !host?.enabled ||
      !row.enabled ||
      !row.serverId ||
      row.serverId !== host.serverId ||
      !row.lastOnlineAt ||
      row.lastOnlineAt !== host.lastOnlineAt ||
      host.status === "error" ||
      row.targetDescription !== host.targetDescription
    )
      continue;
    const origin = pairedLanOrigin(row.connection, row.targetDescription);
    if (!origin) continue;
    const prior = previous.get(row.registrationId);
    // A replacement keeps the old timestamp but persists as connecting. Trust it
    // only after acceptance, or if this exact origin was already confirmed.
    const wasConfirmed =
      prior?.serverId === row.serverId &&
      prior.origin === origin &&
      prior.lastOnlineAt === row.lastOnlineAt;
    if (row.status === "online" || wasConfirmed) {
      confirmed.set(row.registrationId, {
        serverId: row.serverId,
        origin,
        lastOnlineAt: row.lastOnlineAt,
      });
    }
  }
  return confirmed;
}
