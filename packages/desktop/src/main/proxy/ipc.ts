import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { z } from "zod";
import { trustedAppFrame } from "../trusted-app-frame.js";
import {
  DesktopProxyRetestRequired,
  DesktopProxyRevisionConflict,
  DesktopProxyUnavailable,
  type createDesktopProxy,
  type DesktopProxyState,
} from "./desktop-proxy.js";
import { parseControlSocketTarget } from "./native-control.js";
import { proxyUrl, type DesktopProxyScope } from "./policy.js";
import { pairedLanOrigin } from "./paired-lan.js";
import { desktopSlotChanges, proxyRevision } from "./storage.js";

type ProxyBackend = Pick<
  Awaited<ReturnType<typeof createDesktopProxy>>,
  "load" | "test" | "commit"
>;

const settingsSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("system") }),
  z.strictObject({ mode: z.literal("direct") }),
  z.strictObject({
    mode: z.literal("manual"),
    endpoints: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("unified"), url: proxyUrl }),
      z.strictObject({ kind: z.literal("split"), httpUrl: proxyUrl, httpsUrl: proxyUrl }),
    ]),
    bypass: z.array(z.string().max(512)).max(128),
  }),
]);
const loadRequest = z.strictObject({});
const testRequest = z.strictObject({
  change: z.strictObject({ settings: settingsSchema, credentials: desktopSlotChanges }),
  expectedRevision: proxyRevision,
});
const saveRequest = z.strictObject({ validationId: z.uuid(), revision: proxyRevision });
const prepareRequest = z.strictObject({ url: z.string().max(2048) });
const pairedRequest = z.strictObject({ origins: z.array(z.string().max(256)).max(128) });
type DeviceProxyCommand =
  | "get_device_proxy"
  | "test_device_proxy"
  | "set_device_proxy"
  | "prepare_native_control_websocket"
  | "sync_paired_lan_origins";

export function isDeviceProxyCommand(command: unknown): command is DeviceProxyCommand {
  return (
    command === "get_device_proxy" ||
    command === "test_device_proxy" ||
    command === "set_device_proxy" ||
    command === "prepare_native_control_websocket" ||
    command === "sync_paired_lan_origins"
  );
}

function snapshot(state: DesktopProxyState | null, revision: number, suspended = false) {
  const policy = state?.policy ?? { mode: "system" };
  const settings: z.infer<typeof settingsSchema> =
    policy.mode === "manual"
      ? {
          mode: "manual",
          endpoints:
            policy.routes.kind === "unified"
              ? { kind: "unified", url: policy.routes.url }
              : { kind: "split", httpUrl: policy.routes.http, httpsUrl: policy.routes.https },
          bypass: policy.bypass ?? [],
        }
      : { mode: policy.mode };
  return {
    access: "edit" as const,
    revision,
    settings,
    credentialSlots: state?.credentialSlots ?? [],
    supportsBypass: true,
    ...(suspended && { suspended: true }),
  };
}

export function createDeviceProxyCommands(options: {
  trustedUrl: string;
  appWindows: Pick<WeakSet<WebContents>, "has">;
  scope: DesktopProxyScope;
  getBackend(): ProxyBackend | null;
  prepareNative?(frame: WebFrameMain, url: URL): Promise<void>;
  syncPaired?(frame: WebFrameMain, origins: readonly string[]): Promise<void>;
}) {
  const { scope } = options;
  const trusted = new URL(options.trustedUrl);

  async function prepareNative(frame: WebFrameMain, args: unknown) {
    const parsed = prepareRequest.safeParse(args);
    const url = parsed.success && parseControlSocketTarget(parsed.data.url);
    if (!url || !options.prepareNative) return { status: "unavailable" } as const;
    try {
      await options.prepareNative(frame, url);
      return { status: "ready" } as const;
    } catch {
      return { status: "unavailable" } as const;
    }
  }

  async function syncPaired(frame: WebFrameMain, args: unknown) {
    const parsed = pairedRequest.safeParse(args);
    if (!parsed.success || !options.syncPaired) return { status: "unavailable" } as const;
    const origins = parsed.data.origins.map(pairedLanOrigin).filter((origin) => origin !== null);
    if (origins.length !== parsed.data.origins.length) return { status: "unavailable" } as const;
    try {
      await options.syncPaired(frame, [...new Set(origins)]);
      return { status: "ready" } as const;
    } catch {
      return { status: "unavailable" } as const;
    }
  }

  return async (event: IpcMainInvokeEvent, command: DeviceProxyCommand, args: unknown) => {
    const frame = trustedAppFrame(event, options.appWindows, trusted);
    if (!frame) return { status: "denied" } as const;
    if (command === "prepare_native_control_websocket") return prepareNative(frame, args);
    if (command === "sync_paired_lan_origins") return syncPaired(frame, args);
    const backend = options.getBackend();
    if (!backend) return { status: "unavailable" } as const;

    try {
      switch (command) {
        case "get_device_proxy": {
          if (!loadRequest.safeParse(args).success) return { status: "failed" } as const;
          const current = backend.load(scope);
          return {
            status: "loaded",
            snapshot: snapshot(current.state, current.revision, current.suspended),
          } as const;
        }
        case "test_device_proxy": {
          const parsed = testRequest.safeParse(args);
          if (!parsed.success) return { status: "failed" } as const;
          const { change, expectedRevision } = parsed.data;
          const { settings, credentials } = change;
          const policy =
            settings.mode === "manual"
              ? {
                  mode: "manual",
                  bypass: settings.bypass,
                  routes:
                    settings.endpoints.kind === "unified"
                      ? settings.endpoints
                      : {
                          kind: "split",
                          http: settings.endpoints.httpUrl,
                          https: settings.endpoints.httpsUrl,
                        },
                }
              : settings;
          const receipt = await backend.test({ scope, policy, credentials, expectedRevision });
          return { status: "passed", receipt } as const;
        }
        case "set_device_proxy": {
          const parsed = saveRequest.safeParse(args);
          if (!parsed.success) return { status: "retest-required" } as const;
          const saved = await backend.commit(scope, parsed.data);
          return { status: "saved", snapshot: snapshot(saved, saved.revision) } as const;
        }
      }
    } catch (error) {
      if (error instanceof DesktopProxyRevisionConflict)
        return { status: "revision-conflict" } as const;
      if (error instanceof DesktopProxyRetestRequired)
        return { status: "retest-required" } as const;
      if (error instanceof DesktopProxyUnavailable) return { status: "unavailable" } as const;
      return { status: "failed" } as const;
    }
  };
}
