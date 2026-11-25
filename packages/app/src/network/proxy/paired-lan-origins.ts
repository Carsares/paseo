import type { HostRuntimeStore } from "@/runtime/host-runtime";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";

type HostInventory = Pick<
  HostRuntimeStore,
  "getHosts" | "getSnapshot" | "subscribeAll" | "subscribeHostList"
>;

function isLanAddress(hostname: string): boolean {
  // URL has already normalized IPv4 and IPv6 literals. Never resolve a DNS name here.
  if (hostname.startsWith("["))
    return /^(?:\[(?:f[cd][\da-f]{2}|fe[89ab][\da-f])):/i.test(hostname);
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) return false;
  const [first, second = -1] = parts.map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

export function pairedLanOrigins(hosts: HostInventory): string[] {
  const origins = new Set<string>();
  for (const host of hosts.getHosts()) {
    const runtime = hosts.getSnapshot(host.serverId);
    if (
      runtime?.connectionStatus !== "online" ||
      runtime.client?.getLastServerInfoMessage()?.serverId !== host.serverId
    ) {
      continue;
    }
    const connection = host.connections.find((entry) => entry.id === runtime.activeConnectionId);
    if (connection?.type !== "directTcp") continue;
    try {
      const target = new URL(
        buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
      );
      if (isLanAddress(target.hostname)) {
        target.protocol = target.protocol === "wss:" ? "https:" : "http:";
        origins.add(target.origin);
      }
    } catch {
      // Invalid entries do not grant a direct route.
    }
  }
  return [...origins].sort();
}

export function observePairedLanOrigins(
  hosts: HostInventory,
  publish: (origins: string[]) => Promise<void>,
): () => void {
  let published: string | undefined;
  let work: Promise<void> | undefined;
  let stopped = false;
  let dirty = true;
  async function drain() {
    while (dirty) {
      if (stopped) return;
      dirty = false;
      const origins = pairedLanOrigins(hosts);
      const key = origins.join(",");
      if (key === published) continue;
      try {
        await publish(origins);
        published = key;
      } catch {
        // The desktop process will continue enforcing its last verified routes.
        published = undefined;
      }
    }
  }
  function refresh() {
    dirty = true;
    work ??= Promise.resolve()
      .then(drain)
      .finally(() => {
        work = undefined;
        if (dirty && !stopped) refresh();
      });
  }
  const stopHostList = hosts.subscribeHostList(refresh);
  const stopRuntime = hosts.subscribeAll(refresh);
  refresh();
  return () => {
    stopped = true;
    stopHostList();
    stopRuntime();
  };
}
