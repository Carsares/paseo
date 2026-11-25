import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProxySettingsAdapter, ProxySnapshot, ProxyTarget } from "./settings";

type HostProxyClient = Pick<
  DaemonClient,
  "getOutboundProxy" | "testOutboundProxy" | "setOutboundProxy" | "canSendOutboundProxyCredentials"
>;
type HostLoadResult = Awaited<ReturnType<HostProxyClient["getOutboundProxy"]>>;
type HostSnapshot = Extract<HostLoadResult, { status: "loaded" }>["snapshot"];

function toFormSnapshot({ settings, ...snapshot }: HostSnapshot, canSend: boolean): ProxySnapshot {
  snapshot.supportsCredentialReplacement =
    snapshot.supportsCredentialReplacement === true && canSend;
  if (settings.mode !== "manual") return { ...snapshot, settings };
  return {
    ...snapshot,
    settings: { mode: "manual", endpoints: settings.proxy, bypass: settings.bypass ?? [] },
  };
}

interface HostAdapterBinding {
  hostId: string;
  client: HostProxyClient;
  isCurrent: () => boolean;
}

export function createHostProxyAdapter({
  hostId,
  client,
  isCurrent,
}: HostAdapterBinding): ProxySettingsAdapter {
  function canUse(target: ProxyTarget, signal: AbortSignal): boolean {
    return !signal.aborted && target.kind === "host" && target.hostId === hostId && isCurrent();
  }

  return {
    async load(target, signal) {
      if (!canUse(target, signal)) return { status: "unavailable" };
      const result = await client.getOutboundProxy({});
      if (!canUse(target, signal)) return { status: "unavailable" };
      if (result.status !== "loaded") return result;
      return {
        status: "loaded",
        snapshot: toFormSnapshot(result.snapshot, client.canSendOutboundProxyCredentials()),
      };
    },
    async test(target, { change, expectedRevision }, signal) {
      const { settings, credentials } = change;
      if (!canUse(target, signal) || settings.mode === "system") return { status: "unavailable" };
      if (
        Object.values(credentials).some((entry) => entry?.action === "replace") &&
        !client.canSendOutboundProxyCredentials()
      ) {
        return { status: "denied" };
      }
      const hostSettings: HostSnapshot["settings"] =
        settings.mode === "manual"
          ? { mode: settings.mode, proxy: settings.endpoints, bypass: [...settings.bypass] }
          : { mode: settings.mode };
      const result = await client.testOutboundProxy({
        settings: hostSettings,
        credentials,
        expectedRevision,
      });
      if (!canUse(target, signal)) return { status: "unavailable" };
      if (result.status !== "passed") return result;
      const { verificationId, revision, expiresInMs } = result.receipt;
      return { status: "passed", receipt: { validationId: verificationId, revision, expiresInMs } };
    },
    async save(target, { validationId, revision }, signal) {
      if (!canUse(target, signal)) return { status: "unavailable" };
      const result = await client.setOutboundProxy({ verificationId: validationId, revision });
      if (!canUse(target, signal)) return { status: "unavailable" };
      if (result.status !== "saved") return result;
      return {
        status: "saved",
        snapshot: toFormSnapshot(result.snapshot, client.canSendOutboundProxyCredentials()),
      };
    },
  };
}
