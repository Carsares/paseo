import { defaultWebSocketFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";
import type { WebSocketFactory } from "@getpaseo/client/internal/daemon-client-transport-types";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";
import { observePairedLanOrigins } from "@/network/proxy/paired-lan-origins";
import { createPreparedWebSocketFactory } from "@/network/proxy/prepared-websocket";

type DesktopHostWithNativeControl = DesktopHostBridge & {
  nativeControlWebSocket?: true;
};

const factories = new WeakMap<DesktopHostWithNativeControl, WebSocketFactory>();

export function createAppWebSocketFactory(): WebSocketFactory {
  const host: DesktopHostWithNativeControl | null = getDesktopHost();
  // COMPAT(desktopNativeControlWebSocket): added in v0.18.0; remove after 2027-06-01.
  if (!host?.nativeControlWebSocket || !host.invoke) return defaultWebSocketFactory;
  let factory = factories.get(host);
  if (!factory) {
    const invoke = host.invoke;
    factory = createPreparedWebSocketFactory(async (url) => {
      const result = await invoke("prepare_native_control_websocket", { url });
      if (
        !result ||
        typeof result !== "object" ||
        !("status" in result) ||
        result.status !== "ready"
      ) {
        throw new Error("Desktop control socket route is unavailable");
      }
    });
    factories.set(host, factory);
    // The host runtime creates socket factories while constructing its singleton.
    void import("./host-runtime")
      .then(({ getHostRuntimeStore }) =>
        observePairedLanOrigins(getHostRuntimeStore(), async (origins) => {
          const result = await invoke("sync_paired_lan_origins", { origins });
          if (
            !result ||
            typeof result !== "object" ||
            !("status" in result) ||
            result.status !== "ready"
          ) {
            throw new Error("Desktop LAN routes are unavailable");
          }
        }),
      )
      .catch(() => undefined);
  }
  return factory;
}
