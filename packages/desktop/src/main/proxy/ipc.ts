import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IpcMainInvokeEvent, Session, WebContents, WebFrameMain } from "electron";
import { z } from "zod";
import { trustedAppFrame } from "../trusted-app-frame.js";
import {
  DesktopProxyRetestRequired,
  DesktopProxyRevisionConflict,
  DesktopProxyUnavailable,
  type createDesktopProxy,
  type DesktopProxyState,
} from "./desktop-proxy.js";
import { parseControlSocketTarget, resolveRoute } from "./native-control.js";
import { proxyForTarget, proxyUrl, type DesktopProxyScope } from "./policy.js";
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
const prepareDownloadRequest = z.strictObject({
  origin: z.string().max(256),
  fileName: z.string().min(1).max(1024),
});
const directDownloadRequest = z.strictObject({ id: z.uuid(), token: z.string().min(1).max(256) });
const downloadPath = "/api/files/download";
type DownloadCommand = "prepare_direct_file_download" | "start_direct_file_download";
type DeviceProxyCommand =
  | "get_device_proxy"
  | "test_device_proxy"
  | "set_device_proxy"
  | "prepare_native_control_websocket"
  | "sync_paired_lan_origins"
  | DownloadCommand;

function isDownloadCommand(command: unknown): command is DownloadCommand {
  return command === "prepare_direct_file_download" || command === "start_direct_file_download";
}

function parseDownloadOrigin(raw: string): URL | null {
  const url = URL.parse(raw);
  if (!url || url.origin !== raw || url.port === "0") return null;
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

export function isDeviceProxyCommand(command: unknown): command is DeviceProxyCommand {
  return (
    command === "get_device_proxy" ||
    command === "test_device_proxy" ||
    command === "set_device_proxy" ||
    command === "prepare_native_control_websocket" ||
    command === "sync_paired_lan_origins" ||
    isDownloadCommand(command)
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
  const pendingDownloads = new WeakMap<
    WebFrameMain,
    Map<
      string,
      {
        url: URL;
        destination: string;
        expires: number;
      }
    >
  >();
  let downloadSession: Promise<Session> | undefined;

  async function prepareDownload(event: IpcMainInvokeEvent, frame: WebFrameMain, args: unknown) {
    const parsed = prepareDownloadRequest.safeParse(args);
    if (!parsed.success || scope !== "mainWindow") return { status: "failed" } as const;
    const { origin, fileName } = parsed.data;
    const url = parseDownloadOrigin(origin);
    if (!url) return { status: "failed" } as const;
    const policy = options.getBackend()?.load(scope).state?.policy;
    // Loopback, paired LAN and explicitly bypassed targets already use the browser route.
    if (!policy || !proxyForTarget(policy, url) || pairedLanOrigin(origin)) {
      return { status: "use-browser" } as const;
    }
    const { app, BrowserWindow, dialog } = await import("electron");
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return { status: "failed" } as const;
    const suggested = path.win32.basename(fileName).replace(/[\p{Cc}<>:"|?*]/gu, "_");
    const defaultPath = path.join(
      app.getPath("downloads"),
      suggested && !/^\.{1,2}$/.test(suggested) ? suggested : "download",
    );
    const result = await dialog.showSaveDialog(window, { defaultPath });
    if (result.canceled || !result.filePath) return { status: "cancelled" } as const;
    if (trustedAppFrame(event, options.appWindows, trusted) !== frame)
      return { status: "denied" } as const;
    const pending = pendingDownloads.get(frame) ?? new Map();
    const now = performance.now();
    for (const [key, entry] of pending) if (entry.expires <= now) pending.delete(key);
    if (pending.size >= 32) return { status: "failed" } as const;
    const id = randomUUID();
    pending.set(id, {
      url: new URL(downloadPath, origin),
      destination: result.filePath,
      expires: now + 60_000,
    });
    pendingDownloads.set(frame, pending);
    return { status: "ready", id } as const;
  }

  async function startDownload(event: IpcMainInvokeEvent, frame: WebFrameMain, args: unknown) {
    const parsed = directDownloadRequest.safeParse(args);
    if (!parsed.success) return { status: "failed" } as const;
    const downloads = pendingDownloads.get(frame);
    const pending = downloads?.get(parsed.data.id);
    downloads?.delete(parsed.data.id);
    if (!pending || pending.expires <= performance.now()) return { status: "failed" } as const;
    if (!downloadSession) {
      downloadSession = import("electron")
        .then(async ({ session }) => {
          const direct = session.fromPartition("paseo-direct-file-download", { cache: false });
          await direct.setProxy({ mode: "direct" });
          await direct.forceReloadProxyConfig();
          return direct;
        })
        .catch((error: unknown) => {
          downloadSession = undefined;
          throw error;
        });
    }
    const direct = await downloadSession;
    const { url, destination } = pending;
    if ((await resolveRoute(direct, url.href)) !== "DIRECT") return { status: "failed" } as const;
    // Match cross-site browser fetch cookie semantics on the exact download URL.
    const cookies = (await event.sender.session.cookies.get({ url: url.href }))
      .filter((cookie) => cookie.sameSite === "no_restriction")
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
    const temp = await mkdtemp(path.join(path.dirname(destination), ".paseo-download-"));
    try {
      if (trustedAppFrame(event, options.appWindows, trusted) !== frame)
        return { status: "denied" } as const;
      url.searchParams.set("token", parsed.data.token);
      const response = await direct.fetch(url.href, {
        redirect: "error",
        credentials: "omit",
        bypassCustomProtocolHandlers: true,
        headers: cookies ? { Cookie: cookies } : undefined,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: "http-error", code: response.status } as const;
      }
      if (!response.body) return { status: "failed" } as const;
      const partial = path.join(temp, "file");
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(partial, { mode: 0o600 }),
      );
      await rename(partial, destination);
      return { status: "complete" } as const;
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

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

  async function handleDownload(
    event: IpcMainInvokeEvent,
    frame: WebFrameMain,
    command: DownloadCommand,
    args: unknown,
  ) {
    try {
      return await (command === "prepare_direct_file_download"
        ? prepareDownload(event, frame, args)
        : startDownload(event, frame, args));
    } catch {
      return { status: "failed" } as const;
    }
  }

  return async (event: IpcMainInvokeEvent, command: DeviceProxyCommand, args: unknown) => {
    const frame = trustedAppFrame(event, options.appWindows, trusted);
    if (!frame) return { status: "denied" } as const;
    if (command === "prepare_native_control_websocket") return prepareNative(frame, args);
    if (command === "sync_paired_lan_origins") return syncPaired(frame, args);
    if (isDownloadCommand(command)) return handleDownload(event, frame, command, args);
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
