import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UUID } from "builder-util-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  autoUpdaterMock,
  settingsMock,
  releaseInstallLock,
  appEvents,
  nativeUpdateEvents,
  updateEvents,
} = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const handlers = new Map<string, (value: unknown) => void>();
  const updaterEmitter = new EventEmitter();
  return {
    appEvents: new EventEmitter(),
    nativeUpdateEvents: Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(),
      getFeedURL: () => "http://127.0.0.1:32100",
    }),
    updateEvents: updaterEmitter,
    settingsMock: { officialUpdatesEnabled: true },
    releaseInstallLock: vi.fn(),
    autoUpdaterMock: {
      autoDownload: true,
      handlers,
      logger: {
        debug: vi.fn(),
        error: vi.fn((message: unknown) => console.error(message)),
        info: vi.fn(),
        warn: vi.fn(),
      },
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      on: vi.fn((event: string, handler: (value: unknown) => void) => {
        handlers.set(event, handler);
      }),
      once: updaterEmitter.once.bind(updaterEmitter),
      removeListener: updaterEmitter.removeListener.bind(updaterEmitter),
      quitAndInstall: vi.fn(),
    },
  };
});

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => settingsMock,
    beginOfficialUpdateInstall: async () =>
      settingsMock.officialUpdatesEnabled ? releaseInstallLock : null,
  }),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(),
    isPackaged: true,
    on: appEvents.on.bind(appEvents),
    removeListener: appEvents.removeListener.bind(appEvents),
  },
  autoUpdater: nativeUpdateEvents,
}));

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
}));

import {
  bucketFromStagingUserId,
  checkForAppUpdate,
  createAppUpdateLifecycleLogger,
  resolveStagingUserId,
  rolloutManifestSchema,
  shouldAdmitToRollout,
  shouldInstallAppUpdateOnQuit,
} from "./auto-updater";
import { createQuitLifecycle } from "../daemon/quit-lifecycle";

function emitMacUpdateDownloaded(url = `${nativeUpdateEvents.getFeedURL()}/update.zip`): void {
  nativeUpdateEvents.emit("update-downloaded", {}, "", "", new Date(0), url);
}

describe("checkForAppUpdate", () => {
  afterEach(() => {
    settingsMock.officialUpdatesEnabled = true;
  });

  it("prevents an in-flight check from automatically downloading after disabling updates", async () => {
    const downloads = autoUpdaterMock.downloadUpdate.mock.calls.length;
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(async () => {
      settingsMock.officialUpdatesEnabled = false;
      return { isUpdateAvailable: true, updateInfo: { version: "1.2.4" } };
    });
    const result = await checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    expect(result.hasUpdate).toBe(false);
    expect(autoUpdaterMock.autoDownload).toBe(false);
    expect(autoUpdaterMock.downloadUpdate.mock.calls).toHaveLength(downloads);
  });

  it("starts a background download when official updates are enabled", async () => {
    const downloads = autoUpdaterMock.downloadUpdate.mock.calls.length;
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: "1.2.4" },
    });
    const result = await checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    expect(result.hasUpdate).toBe(true);
    expect(autoUpdaterMock.downloadUpdate.mock.calls).toHaveLength(downloads + 1);
  });

  it("treats an unpublished channel manifest as an unavailable update", async () => {
    const error = Object.assign(new Error("Cannot find latest-mac.yml"), {
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(async () => {
      autoUpdaterMock.logger.error(error);
      autoUpdaterMock.handlers.get("error")?.(error);
      throw error;
    });

    const result = await checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    expect(result).toEqual({
      hasUpdate: false,
      readyToInstall: false,
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      body: null,
      date: null,
      errorMessage: null,
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps genuine updater failures visible", async () => {
    const error = new Error("network down");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(async () => {
      autoUpdaterMock.logger.error(error);
      autoUpdaterMock.handlers.get("error")?.(error);
      throw error;
    });

    const result = await checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    expect(result.errorMessage).toBe("network down");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("logs the update handoff with current and selected target versions", () => {
    const info = vi.fn();
    const lifecycleLog = createAppUpdateLifecycleLogger({ info });

    lifecycleLog.checkStarted({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    lifecycleLog.checkCompleted({
      currentVersion: "1.2.3",
      targetVersion: "1.2.5",
      releaseChannel: "stable",
      intent: "manual",
      hasUpdate: true,
      readyToInstall: true,
      errorMessage: null,
    });
    lifecycleLog.updateDownloaded("1.2.4");
    lifecycleLog.downloadRequested("1.2.5");
    lifecycleLog.quitAndInstallRequested({
      targetVersion: "1.2.5",
      isSilent: false,
      isForceRunAfter: true,
    });

    expect(info).toHaveBeenCalledWith("[auto-updater] check started", {
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    expect(info).toHaveBeenCalledWith("[auto-updater] update downloaded", {
      targetVersion: "1.2.4",
    });
    expect(info).toHaveBeenCalledWith("[auto-updater] download requested", {
      targetVersion: "1.2.5",
    });
    expect(info).toHaveBeenCalledWith("[auto-updater] quitAndInstall requested", {
      targetVersion: "1.2.5",
      isSilent: false,
      isForceRunAfter: true,
    });
  });
});

describe("manual installer handoff", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

  let updater: typeof import("./auto-updater");

  beforeEach(async () => {
    vi.resetModules();
    updater = await import("./auto-updater");
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vi.useRealTimers();
    settingsMock.officialUpdatesEnabled = true;
    releaseInstallLock.mockClear();
    autoUpdaterMock.quitAndInstall.mockReset();
    autoUpdaterMock.downloadUpdate.mockReset();
    nativeUpdateEvents.checkForUpdates.mockReset();
  });

  it("waits for Electron to accept the installer and restores the daemon after an async error", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const info = { version: "1.2.4" };
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: info,
    });
    autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
      autoUpdaterMock.handlers.get("update-downloaded")?.(info);
    });
    const restore = vi.fn(async () => {});
    let completed = false;
    const pending = updater
      .downloadAndInstallUpdate(
        { currentVersion: "1.2.3", releaseChannel: "stable" },
        async () => ({ restore, beforeHandoff: async () => {} }),
      )
      .finally(() => {
        completed = true;
      });

    await expect.poll(() => autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(completed).toBe(false);
    updateEvents.emit("error", new Error("Native update rejected"));

    expect(await pending).toMatchObject({
      installed: false,
      message: expect.stringContaining("Native update rejected"),
    });
    expect(restore).toHaveBeenCalledOnce();
    expect(nativeUpdateEvents.listenerCount("before-quit-for-update")).toBe(0);
  });

  it("restores the daemon on a native error and ignores an earlier feed during retry", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const info = { version: "1.2.5" };
    const input = { currentVersion: "1.2.3", releaseChannel: "stable" } as const;
    autoUpdaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: info,
    });
    autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
      autoUpdaterMock.handlers.get("update-downloaded")?.(info);
    });
    const restore = vi.fn(async () => {});
    const onBeforeQuit = vi.fn(async () => ({ restore, beforeHandoff: async () => {} }));
    const failed = updater.downloadAndInstallUpdate(input, onBeforeQuit);
    await expect.poll(() => nativeUpdateEvents.checkForUpdates.mock.calls.length).toBe(1);
    expect(onBeforeQuit).toHaveBeenCalledExactlyOnceWith(info);
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    nativeUpdateEvents.emit("error", new Error("Squirrel failed to stage the update"));
    expect(await failed).toMatchObject({
      installed: false,
      message: expect.stringContaining("Squirrel failed"),
    });
    expect(restore).toHaveBeenCalledOnce();
    expect(releaseInstallLock).toHaveBeenCalledOnce();

    // An event after the rejected attempt cannot quit the app.
    emitMacUpdateDownloaded();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();

    const retry = updater.downloadAndInstallUpdate(input, onBeforeQuit);
    await expect.poll(() => nativeUpdateEvents.checkForUpdates.mock.calls.length).toBe(2);
    emitMacUpdateDownloaded("http://127.0.0.1:32101/old-update.zip");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    emitMacUpdateDownloaded();
    await expect.poll(() => autoUpdaterMock.quitAndInstall.mock.calls).toEqual([[false, true]]);
    nativeUpdateEvents.emit("before-quit-for-update");
    expect(await retry).toMatchObject({ installed: true, version: info.version });
    expect(onBeforeQuit.mock.calls).toEqual([[info], [info]]);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("preserves recovery when macOS reports a synchronous error after acknowledging the quit", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const info = { version: "1.2.13" };
    autoUpdaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: info,
    });
    autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
      autoUpdaterMock.handlers.get("update-downloaded")?.(info);
    });
    nativeUpdateEvents.checkForUpdates.mockImplementation(() => emitMacUpdateDownloaded());
    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      nativeUpdateEvents.emit("before-quit-for-update");
      updateEvents.emit("error", new Error("Native install failed"));
    });
    const restore = vi.fn(async () => {});
    const preserveForNextLaunch = vi.fn(async () => {});
    const result = await updater.downloadAndInstallUpdate(
      { currentVersion: "1.2.3", releaseChannel: "stable" },
      async () => ({ restore, preserveForNextLaunch, beforeHandoff: async () => {} }),
    );

    expect(result).toMatchObject({
      installed: false,
      message: expect.stringContaining("macOS may install the update on exit"),
    });
    expect(restore).not.toHaveBeenCalled();
    expect(preserveForNextLaunch).toHaveBeenCalledOnce();
    expect(releaseInstallLock).toHaveBeenCalledOnce();
    expect(updater.hasAcceptedNativeUpdateQuit()).toBe(false);
  });

  it("does not restore the daemon if an unexpected native download is followed by an error", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const info = { version: "1.2.13" };
    autoUpdaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: info,
    });
    autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
      autoUpdaterMock.handlers.get("update-downloaded")?.(info);
    });
    nativeUpdateEvents.checkForUpdates.mockImplementation(() => {
      emitMacUpdateDownloaded("http://127.0.0.1:32101/other-update.zip");
      nativeUpdateEvents.emit("error", new Error("The selected update failed"));
    });
    const restore = vi.fn(async () => {});
    const preserveForNextLaunch = vi.fn(async () => {});
    const result = await updater.downloadAndInstallUpdate(
      { currentVersion: "1.2.3", releaseChannel: "stable" },
      async () => ({ restore, preserveForNextLaunch, beforeHandoff: async () => {} }),
    );

    expect(result).toMatchObject({
      installed: false,
      message: expect.stringContaining("macOS may install the update on exit"),
    });
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(preserveForNextLaunch).toHaveBeenCalledOnce();
  });

  it("acknowledges the macOS no-relaunch exit only after native staging completes", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const info = { version: "1.2.6" };
    const input = { currentVersion: "1.2.3", releaseChannel: "stable" } as const;
    autoUpdaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: info,
    });
    autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
      autoUpdaterMock.handlers.get("update-downloaded")?.(info);
    });
    await updater.checkForAppUpdate({ ...input, intent: "automatic" });
    const validation = Promise.withResolvers<void>();
    const beforeHandoff = vi.fn(() => validation.promise);
    const onBeforeQuit = vi.fn(async () => ({ beforeHandoff, restore: async () => {} }));
    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      expect(updater.isMacUpdateQuitInProgress()).toBe(true);
      appEvents.emit("before-quit");
    });
    const install = updater.installAppUpdateOnQuit({
      ...input,
      signal: new AbortController().signal,
      onBeforeQuit,
    });
    await expect.poll(() => beforeHandoff).toHaveBeenCalledOnce();
    expect(nativeUpdateEvents.checkForUpdates).not.toHaveBeenCalled();
    validation.resolve();
    await expect.poll(() => nativeUpdateEvents.checkForUpdates.mock.calls.length).toBe(1);
    expect(onBeforeQuit).toHaveBeenCalledExactlyOnceWith(info);
    expect(updater.isMacUpdateQuitInProgress()).toBe(false);
    appEvents.emit("before-quit");
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    emitMacUpdateDownloaded();
    expect(await install).toBe(true);
    expect(onBeforeQuit).toHaveBeenCalledExactlyOnceWith(info);
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, false);
    expect(updater.isMacUpdateQuitInProgress()).toBe(false);
  });

  it.each([false, true])(
    "keeps the daemon stopped after macOS native handoff fails (manual: %s)",
    async (manual) => {
      Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
      const info = { version: "1.2.14" };
      const input = { currentVersion: "1.2.3", releaseChannel: "stable" } as const;
      autoUpdaterMock.checkForUpdates.mockResolvedValue({
        isUpdateAvailable: true,
        updateInfo: info,
      });
      autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
        autoUpdaterMock.handlers.get("update-downloaded")?.(info);
      });
      nativeUpdateEvents.checkForUpdates.mockImplementation(() => emitMacUpdateDownloaded());
      await updater.checkForAppUpdate({ ...input, intent: "automatic" });
      const restore = vi.fn(async () => {});
      const preserveForNextLaunch = vi.fn(async () => {});
      const onBeforeQuit = async () => ({
        restore,
        preserveForNextLaunch,
        beforeHandoff: async () => {},
      });
      const install = manual
        ? updater.downloadAndInstallUpdate(input, onBeforeQuit)
        : updater.installAppUpdateOnQuit({
            ...input,
            signal: new AbortController().signal,
            onBeforeQuit,
          });

      await expect.poll(() => autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce();
      appEvents.emit("before-quit");
      updateEvents.emit("error", new Error("Updater did not call app.quit"));
      if (manual) {
        expect(await install).toMatchObject({
          installed: false,
          message: expect.stringContaining("macOS may install the update on exit"),
        });
      } else {
        expect(await install).toBe(false);
      }
      expect(restore).not.toHaveBeenCalled();
      expect(preserveForNextLaunch).toHaveBeenCalledOnce();
      expect(nativeUpdateEvents.listenerCount("before-quit-for-update")).toBe(0);
      expect(appEvents.listenerCount("before-quit")).toBe(0);
    },
  );

  it("honors disabling updates while macOS is downloading the ZIP", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const info = { version: "1.2.7" };
    autoUpdaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: info,
    });
    const download = Promise.withResolvers<void>();
    autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
      await download.promise;
      autoUpdaterMock.handlers.get("update-downloaded")?.(info);
    });
    const onBeforeQuit = vi.fn(async () => {});
    const install = updater.downloadAndInstallUpdate(
      { currentVersion: "1.2.3", releaseChannel: "stable" },
      onBeforeQuit,
    );
    await expect.poll(() => autoUpdaterMock.downloadUpdate.mock.calls.length).toBeGreaterThan(0);
    settingsMock.officialUpdatesEnabled = false;
    download.resolve();

    expect(await install).toMatchObject({
      installed: false,
      message: "Official updates are disabled.",
    });
    expect(onBeforeQuit).not.toHaveBeenCalled();
    expect(nativeUpdateEvents.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each(["updates disabled", "recovery changed"] as const)(
    "restores after final validation rejects a macOS update (%s)",
    async (reason) => {
      Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
      const info = { version: "1.2.11" };
      autoUpdaterMock.checkForUpdates.mockResolvedValue({
        isUpdateAvailable: true,
        updateInfo: info,
      });
      autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
        autoUpdaterMock.handlers.get("update-downloaded")?.(info);
      });
      const restore = vi.fn(async () => {});
      const shutdown = { restore, beforeHandoff: async () => {} };
      const revalidate = Promise.withResolvers<void>();
      const beforeHandoff = vi.fn(() => revalidate.promise);
      const onBeforeQuit = vi.fn(async () => ({ ...shutdown, beforeHandoff }));
      const install = updater.downloadAndInstallUpdate(
        { currentVersion: "1.2.3", releaseChannel: "stable" },
        onBeforeQuit,
      );
      await expect.poll(() => beforeHandoff).toHaveBeenCalledOnce();
      if (reason === "updates disabled") {
        settingsMock.officialUpdatesEnabled = false;
        revalidate.resolve();
      } else {
        revalidate.reject(new Error("Daemon recovery changed before the update."));
      }

      expect(await install).toMatchObject({
        installed: false,
        message: expect.stringContaining(
          reason === "updates disabled"
            ? "Official updates are disabled."
            : "Daemon recovery changed",
        ),
      });
      expect(restore).toHaveBeenCalledOnce();
      expect(nativeUpdateEvents.checkForUpdates).not.toHaveBeenCalled();
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    },
  );

  it("quits normally when a newer ZIP misses the deadline and ignores the late events", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const info = { version: "1.2.8" };
    const input = { currentVersion: "1.2.3", releaseChannel: "stable" } as const;
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: info,
    });
    autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
      autoUpdaterMock.handlers.get("update-downloaded")?.(info);
    });
    await updater.checkForAppUpdate({ ...input, intent: "automatic" });
    const newer = { version: "1.2.9" };
    const download = Promise.withResolvers<void>();
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: newer,
    });
    autoUpdaterMock.downloadUpdate.mockClear();
    autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
      await download.promise;
      autoUpdaterMock.handlers.get("update-downloaded")?.(newer);
    });
    const deadline = new AbortController();
    const exit = vi.fn();
    const stopDaemon = vi.fn(async () => true);
    const installFinished = Promise.withResolvers<boolean>();
    const lifecycle = createQuitLifecycle({
      app: { exit },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: stopDaemon,
      installAppUpdateOnQuit: async (signal, onBeforeQuit) => {
        const installed = await updater.installAppUpdateOnQuit({ ...input, signal, onBeforeQuit });
        installFinished.resolve(installed);
        return installed;
      },
      createUpdateDeadlineSignal: () => deadline.signal,
      onStopError: vi.fn(),
      onUpdateError: vi.fn(),
    });
    lifecycle.handleBeforeQuit({ preventDefault: vi.fn() });
    await expect.poll(() => autoUpdaterMock.downloadUpdate.mock.calls.length).toBeGreaterThan(0);
    deadline.abort();
    await expect.poll(() => exit.mock.calls).toEqual([[0]]);
    expect(stopDaemon.mock.calls).toEqual([[]]);
    download.resolve();
    expect(await installFinished.promise).toBe(false);
    emitMacUpdateDownloaded();

    expect(stopDaemon.mock.calls).toEqual([[]]);
    expect(nativeUpdateEvents.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it("bounds macOS preparation, preserves recovery for next launch and ignores late native events", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const info = { version: "1.2.10" };
    const input = { currentVersion: "1.2.3", releaseChannel: "stable" } as const;
    autoUpdaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: info,
    });
    autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
      autoUpdaterMock.handlers.get("update-downloaded")?.(info);
    });
    await updater.checkForAppUpdate({ ...input, intent: "automatic" });
    const deadline = new AbortController();
    const exit = vi.fn();
    const stopDaemon = vi.fn(async () => true);
    const restore = vi.fn(async () => {});
    const preserveForNextLaunch = vi.fn(async () => {});
    const prepare = vi.fn(async () => ({
      restore,
      preserveForNextLaunch,
      beforeHandoff: async () => {},
    }));
    const lifecycle = createQuitLifecycle({
      app: { exit },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: stopDaemon,
      prepareDaemonForAppUpdate: prepare,
      installAppUpdateOnQuit: (signal, onBeforeQuit) =>
        updater.installAppUpdateOnQuit({ ...input, signal, onBeforeQuit }),
      createUpdateDeadlineSignal: () => deadline.signal,
      onStopError: vi.fn(),
      onUpdateError: vi.fn(),
    });
    lifecycle.handleBeforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(nativeUpdateEvents.checkForUpdates).toHaveBeenCalledOnce());
    expect(prepare).toHaveBeenCalledExactlyOnceWith(info);
    deadline.abort();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(restore).not.toHaveBeenCalled();
    expect(preserveForNextLaunch).toHaveBeenCalledOnce();
    expect(releaseInstallLock).toHaveBeenCalledOnce();
    expect(nativeUpdateEvents.listenerCount("update-downloaded")).toBe(0);
    expect(nativeUpdateEvents.listenerCount("update-not-available")).toBe(0);
    expect(nativeUpdateEvents.listenerCount("error")).toBe(0);
    emitMacUpdateDownloaded();
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it("times out a manual handoff and clears listeners and ownership before a late event", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const info = { version: "1.2.12" };
    autoUpdaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: info,
    });
    autoUpdaterMock.downloadUpdate.mockImplementation(async () => {
      autoUpdaterMock.handlers.get("update-downloaded")?.(info);
    });
    const restore = vi.fn(async () => {});
    const pending = updater.downloadAndInstallUpdate(
      { currentVersion: "1.2.3", releaseChannel: "stable" },
      async () => ({ restore, beforeHandoff: async () => {} }),
    );
    await vi.waitFor(() => expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce());
    expect(updater.isNativeUpdateHandoffInProgress()).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({
      installed: false,
      message: expect.stringContaining("ownership"),
    });
    expect(restore).toHaveBeenCalledOnce();
    expect(updater.isNativeUpdateHandoffInProgress()).toBe(false);
    expect(updateEvents.listenerCount("error")).toBe(0);

    const retryShutdown = vi.fn(async () => ({ restore, beforeHandoff: async () => {} }));
    const retry = updater.downloadAndInstallUpdate(
      { currentVersion: "1.2.3", releaseChannel: "stable" },
      retryShutdown,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeUpdateEvents.emit("before-quit-for-update")).toBe(false);
    expect(await retry).toMatchObject({
      installed: false,
      message: expect.stringContaining("Restart Paseo"),
    });
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce();
    expect(updater.hasAcceptedNativeUpdateQuit()).toBe(false);
    expect(retryShutdown).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
  });
});

describe("shouldInstallAppUpdateOnQuit", () => {
  it("keeps Linux AppImage updates on the manual install path", () => {
    expect(shouldInstallAppUpdateOnQuit({ platform: "linux", isAppImage: true })).toBe(false);
    expect(shouldInstallAppUpdateOnQuit({ platform: "linux", isAppImage: false })).toBe(true);
    expect(shouldInstallAppUpdateOnQuit({ platform: "darwin", isAppImage: false })).toBe(true);
    expect(shouldInstallAppUpdateOnQuit({ platform: "win32", isAppImage: false })).toBe(true);
  });
});

describe("shouldAdmitToRollout", () => {
  it("admits beta, missing rollout hours, zero-hour rollout, and missing release date", () => {
    expect(
      shouldAdmitToRollout({
        channel: "beta",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: undefined,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 0,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: undefined,
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("blocks future releases and respects the linear threshold mid-rollout", () => {
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T02:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0,
      }),
    ).toBe(false);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.49,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.51,
      }),
    ).toBe(false);
  });

  it("blocks the bucket-zero client at exact release time, admits as soon as time advances", () => {
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T00:00:00.000Z"),
        bucket: 0,
      }),
    ).toBe(false);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T00:00:00.001Z"),
        bucket: 0,
      }),
    ).toBe(true);
  });

  it("admits the highest-bucket client at and past the rollout end", () => {
    const maxBucket = (0x100000000 - 1) / 0x100000000;
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-29T00:00:00.000Z"),
        bucket: maxBucket,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2027-04-28T00:00:00.000Z"),
        bucket: maxBucket,
      }),
    ).toBe(true);
  });

  it("admits when releaseDate is unparseable", () => {
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "not a date",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("treats garbage manifest rollout fields as missing and admits", () => {
    const parsed = rolloutManifestSchema.parse({
      rolloutHours: "not a number",
      releaseDate: 12345,
    });

    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: parsed.rolloutHours,
        releaseDate: parsed.releaseDate,
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("maps the maximum 32-bit slot to a bucket strictly less than 1", () => {
    const allOnes = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const allZeros = "00000000-0000-0000-0000-000000000000";
    expect(bucketFromStagingUserId(allOnes)).toBeLessThan(1);
    expect(bucketFromStagingUserId(allOnes)).toBeGreaterThan(0.999);
    expect(bucketFromStagingUserId(allZeros)).toBe(0);
  });

  it("creates and then reuses the on-disk staging user id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-updater-id-"));
    const filePath = path.join(tempDir, ".updaterId");

    try {
      const first = await resolveStagingUserId(filePath);
      const stored = (await readFile(filePath, "utf8")).trim();
      const second = await resolveStagingUserId(filePath);

      expect(UUID.check(stored)).toBeTruthy();
      expect(second).toBe(first);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
