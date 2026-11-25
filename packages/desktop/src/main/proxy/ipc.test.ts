import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createDesktopProxy } from "./desktop-proxy.js";
import { createDeviceProxyCommands } from "./ipc.js";
import type { StoredProxySettings } from "./storage.js";

const download = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  resolveProxy: vi.fn(async (_url: string) => "DIRECT"),
  setProxy: vi.fn(async () => undefined),
  showSaveDialog: vi.fn<() => Promise<{ canceled: boolean; filePath: string }>>(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showSaveDialog: download.showSaveDialog },
  session: {
    fromPartition: () => ({ ...download, forceReloadProxyConfig: async () => undefined }),
  },
}));

async function setup() {
  let stored: StoredProxySettings = { version: 1, scopes: {} };
  const probe = vi.fn(async () => undefined);
  const backend = await createDesktopProxy({
    scopes: {
      mainWindow: {
        routing: { pairedLanHosts: [], independentDirectLan: true, webSockets: true },
        test: probe,
        async apply() {},
        resume() {},
        isolate() {},
      },
    },
    store: {
      async load() {
        return stored;
      },
      async save(next) {
        stored = next;
      },
    },
    vault: {
      seal: () => "Y2lwaGVydGV4dA==",
      open: () => {
        throw new Error("Key store unavailable");
      },
    },
  });
  const frame = { url: "paseo://app/settings" };
  const sender = {
    mainFrame: frame,
    isDestroyed: () => false,
    session: { cookies: { get: async () => [] } },
  } as unknown as WebContents;
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const appWindows = new WeakSet([sender]);
  const trustedUrl = "paseo://app/";
  const invoke = createDeviceProxyCommands({
    trustedUrl,
    appWindows,
    scope: "mainWindow",
    getBackend: () => backend,
  });
  return { invoke, event, sender, frame, probe, appWindows, trustedUrl };
}

describe("device proxy commands", () => {
  it("streams a 65 MiB DNS-host download via the verified direct session", async () => {
    const { invoke, event } = await setup();
    const tested = await invoke(event, "test_device_proxy", {
      expectedRevision: 0,
      change: {
        settings: {
          mode: "manual",
          endpoints: { kind: "unified", url: "http://proxy.example" },
          bypass: [],
        },
        credentials: {},
      },
    });
    if (tested.status !== "passed") throw new Error("Expected a validation receipt");
    await expect(
      invoke(event, "set_device_proxy", {
        validationId: tested.receipt.validationId,
        revision: tested.receipt.revision,
      }),
    ).resolves.toMatchObject({ status: "saved" });

    const directory = await mkdtemp(path.join(tmpdir(), "paseo-download-test-"));
    try {
      const destination = path.join(directory, "file.bin");
      download.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
      const prepared = await invoke(event, "prepare_direct_file_download", {
        origin: "https://paired.example:8443",
        fileName: "file.bin",
      });
      if (prepared.status !== "ready" || !("id" in prepared))
        throw new Error("Expected a download ID");
      const chunk = new Uint8Array(1024 * 1024);
      let remaining = 65;
      download.fetch.mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            pull(controller) {
              if (remaining-- > 0) controller.enqueue(chunk);
              else controller.close();
            },
          }),
        ),
      );
      const args = { id: prepared.id, token: "fixture-token" };
      await expect(invoke(event, "start_direct_file_download", args)).resolves.toEqual({
        status: "complete",
      });
      expect(download.setProxy).toHaveBeenCalledWith({ mode: "direct" });
      expect(download.resolveProxy).toHaveBeenCalledWith(
        "https://paired.example:8443/api/files/download",
      );
      expect(download.fetch).toHaveBeenCalledExactlyOnceWith(
        "https://paired.example:8443/api/files/download?token=fixture-token",
        expect.objectContaining({ redirect: "error", credentials: "omit" }),
      );
      expect((await stat(destination)).size).toBe(65 * chunk.length);
      await expect(invoke(event, "start_direct_file_download", args)).resolves.toEqual({
        status: "failed",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces the paired LAN snapshot with canonical local origins only", async () => {
    const { event, sender, frame, appWindows, trustedUrl } = await setup();
    const syncPaired = vi.fn(async () => undefined);
    const invoke = createDeviceProxyCommands({
      trustedUrl,
      appWindows,
      scope: "mainWindow",
      getBackend: () => null,
      syncPaired,
    });
    const origins = ["http://192.168.44.55:6769/", "https://[fd00:0::1]:8443"];
    await expect(
      invoke({ ...event, sender: { ...sender } }, "sync_paired_lan_origins", { origins }),
    ).resolves.toEqual({ status: "denied" });
    for (const origin of [
      "http://example.com",
      "http://192.168.44.55:6769/file",
      "http://192.168.44.55:6769?token=test",
      "http://@192.168.44.55:6769",
    ]) {
      await expect(
        invoke(event, "sync_paired_lan_origins", { origins: [origins[0], origin] }),
      ).resolves.toEqual({ status: "unavailable" });
    }
    expect(syncPaired).not.toHaveBeenCalled();
    await expect(invoke(event, "sync_paired_lan_origins", { origins })).resolves.toEqual({
      status: "ready",
    });
    expect(syncPaired).toHaveBeenCalledWith(frame, [
      "http://192.168.44.55:6769",
      "https://[fd00::1]:8443",
    ]);
    await expect(invoke(event, "sync_paired_lan_origins", { origins: [] })).resolves.toEqual({
      status: "ready",
    });
    expect(syncPaired).toHaveBeenLastCalledWith(frame, []);
  });

  it("prepares only exact daemon WebSocket targets from the trusted app frame", async () => {
    const { event, sender, frame, appWindows, trustedUrl } = await setup();
    const prepareNative = vi.fn(async () => undefined);
    const invoke = createDeviceProxyCommands({
      trustedUrl,
      appWindows,
      scope: "mainWindow",
      getBackend: () => null,
      prepareNative,
    });
    const url = "wss://host.example/ws?serverId=fixture&role=client&v=2";
    await expect(
      invoke({ ...event, sender: { ...sender } }, "prepare_native_control_websocket", { url }),
    ).resolves.toEqual({ status: "denied" });
    await expect(
      invoke(event, "prepare_native_control_websocket", { url: "wss://host.example/other" }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(prepareNative).not.toHaveBeenCalled();
    await expect(invoke(event, "prepare_native_control_websocket", { url })).resolves.toEqual({
      status: "ready",
    });
    expect(prepareNative).toHaveBeenCalledExactlyOnceWith(frame, new URL(url));
  });

  it("accepts only the registered app window's current trusted top frame", async () => {
    const { invoke, event, sender, frame, probe } = await setup();
    const anotherFrame = { ...event, senderFrame: { ...frame } } as IpcMainInvokeEvent;
    const anotherWindow = { ...event, sender: { ...sender } };
    await expect(invoke(anotherFrame, "test_device_proxy", {})).resolves.toEqual({
      status: "denied",
    });
    await expect(invoke(anotherWindow, "set_device_proxy", {})).resolves.toEqual({
      status: "denied",
    });
    frame.url = "https://app/settings";
    await expect(invoke(event, "get_device_proxy", {})).resolves.toEqual({ status: "denied" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns the initial revision, commits the tested draft, and exposes only credential slots", async () => {
    const { invoke, event, probe } = await setup();
    const initialSnapshot = {
      access: "edit",
      revision: 0,
      settings: { mode: "system" },
      credentialSlots: [],
      supportsBypass: true,
    };
    await expect(invoke(event, "get_device_proxy", {})).resolves.toEqual({
      status: "loaded",
      snapshot: initialSnapshot,
    });
    const settings = {
      mode: "manual",
      endpoints: { kind: "unified", url: "http://proxy.example:8080" },
      bypass: ["local.example"],
    };
    const change = {
      settings,
      credentials: {
        unified: { action: "replace", credential: { username: "user", password: "test-only" } },
      },
    };
    const tested = await invoke(event, "test_device_proxy", { change, expectedRevision: 0 });
    expect(tested).toEqual({
      status: "passed",
      receipt: { validationId: expect.any(String), revision: 0, expiresInMs: 60_000 },
    });
    if (tested.status !== "passed") throw new Error("Expected a validation receipt");
    const { validationId, revision } = tested.receipt;
    await expect(invoke(event, "get_device_proxy", {})).resolves.toEqual({
      status: "loaded",
      snapshot: initialSnapshot,
    });
    await expect(
      invoke(event, "set_device_proxy", { validationId, revision, change }),
    ).resolves.toEqual({ status: "retest-required" });
    await expect(invoke(event, "set_device_proxy", { validationId, revision })).resolves.toEqual({
      status: "saved",
      snapshot: { ...initialSnapshot, revision: 1, settings, credentialSlots: ["unified"] },
    });
    expect(probe).toHaveBeenCalledTimes(1);
    await expect(
      invoke(event, "test_device_proxy", { change, expectedRevision: 0 }),
    ).resolves.toEqual({ status: "revision-conflict" });
    await expect(invoke(event, "set_device_proxy", { validationId, revision })).resolves.toEqual({
      status: "revision-conflict",
    });
    await expect(invoke(event, "set_device_proxy", { validationId, revision: 1 })).resolves.toEqual(
      { status: "retest-required" },
    );
  });

  it("reports unavailable and hides candidate errors", async () => {
    const { invoke, event, probe, appWindows, trustedUrl } = await setup();
    const unavailable = createDeviceProxyCommands({
      trustedUrl,
      appWindows,
      scope: "mainWindow",
      getBackend: () => null,
    });
    await expect(unavailable(event, "get_device_proxy", {})).resolves.toEqual({
      status: "unavailable",
    });
    probe.mockRejectedValueOnce(new Error("private proxy address or credential"));
    await expect(
      invoke(event, "test_device_proxy", {
        expectedRevision: 0,
        change: { settings: { mode: "direct" }, credentials: {} },
      }),
    ).resolves.toEqual({ status: "failed" });
  });
});
