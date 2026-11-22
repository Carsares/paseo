import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentStorage,
  parseStoredAgentRecord,
} from "../../../server/src/server/agent/agent-storage";
import { createRestartRecovery } from "../../../server/src/server/agent/restart-recovery";
import { createTestLogger } from "../../../server/src/test-utils/test-logger";
import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import { createAppUpdateService } from "../features/app-update-service";
import { ExternalCliCommandError } from "./cli/external";
import {
  createDaemonCommandHandlers,
  isDesktopManagedDaemonPresentSync,
  isDesktopManagedDaemonRunningSync,
  isManualUpdateHandoffInProgress,
  keepsTerminalsOnStop,
  prepareBuiltInDaemonForUpdate,
  resumesAgentsOnStop,
  stopCapturedDaemon,
  stopDesktopDaemon,
  type DesktopDaemonStopReason,
} from "./daemon-manager";
import { createQuitLifecycle, stopDesktopManagedDaemonOnQuitIfNeeded } from "./quit-lifecycle";

const mocks = vi.hoisted(() => ({
  paseoHome: "",
  appVersion: "1.2.3",
  settings: {
    releaseChannel: "stable",
    daemon: {
      manageBuiltInDaemon: true,
      keepRunningAfterQuit: true,
    },
  },
  runExternalCliJsonCommand: vi.fn(),
  runExternalCliTextCommand: vi.fn(),
  createNodeEntrypointInvocation: vi.fn(() => ({
    command: "node",
    args: [],
    env: {},
  })),
  spawnProcess: vi.fn(),
  startDaemonInstance: vi.fn(),
  stopDaemonInstance: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  appLogPath: "",
  getElectronLogFile: vi.fn(),
  confirmUpdate: vi.fn(),
  installUpdate: vi.fn(),
}));

const { nativeUpdater, updateSource } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  return {
    nativeUpdater: Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(),
      getFeedURL: vi.fn(() => "http://127.0.0.1:32100"),
    }),
    updateSource: Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
    }),
  };
});

const approvedUpdate = { version: "1.2.4" };

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  // Keep PID-lock checks independent of the host boot time and sandbox syscalls.
  uptime: () => 3600,
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => mocks.paseoHome),
    getVersion: vi.fn(() => mocks.appVersion),
    isPackaged: true,
  },
  autoUpdater: nativeUpdater,
  ipcMain: { handle: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));

vi.mock("electron-updater", () => ({ autoUpdater: updateSource }));

vi.mock("electron-log/main", () => ({
  default: {
    info: mocks.logInfo,
    error: mocks.logError,
    transports: {
      file: {
        getFile: mocks.getElectronLogFile,
      },
    },
  },
}));

vi.mock("@getpaseo/server/daemon-control", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePaseoHome: () => mocks.paseoHome,
  spawnProcess: mocks.spawnProcess,
  startDaemonInstance: mocks.startDaemonInstance,
  stopDaemonInstance: mocks.stopDaemonInstance,
}));

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    beginOfficialUpdateInstall: async () => () => {},
    get: async () => mocks.settings,
    patch: vi.fn(),
    migrateLegacyRendererSettings: vi.fn(),
  }),
}));

vi.mock("./runtime-paths.js", () => ({
  createNodeEntrypointInvocation: mocks.createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint: vi.fn(() => ({
    entryPath: path.join(mocks.paseoHome, "daemon.js"),
    execArgv: [],
  })),
}));

vi.mock("./cli/external.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runExternalCliJsonCommand: mocks.runExternalCliJsonCommand,
  runExternalCliTextCommand: mocks.runExternalCliTextCommand,
}));

vi.mock("../features/auto-updater.js", () => ({
  checkForAppUpdate: vi.fn(),
  confirmOfficialUpdateWithoutAgentResume: mocks.confirmUpdate,
  downloadAndInstallUpdate: mocks.installUpdate,
}));

describe("daemon-manager commands", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo daemon manager "));
    mocks.paseoHome = path.join(fixtureRoot, "home");
    mocks.appLogPath = path.join(fixtureRoot, "main.log");
    mocks.appVersion = "1.2.3";
    mocks.settings = DEFAULT_DESKTOP_SETTINGS;
    mocks.runExternalCliJsonCommand.mockReset();
    mocks.runExternalCliTextCommand.mockReset();
    mocks.createNodeEntrypointInvocation.mockReset();
    mocks.createNodeEntrypointInvocation.mockReturnValue({ command: "node", args: [], env: {} });
    mocks.spawnProcess.mockReset();
    mocks.startDaemonInstance.mockReset();
    mocks.stopDaemonInstance.mockReset();
    mocks.logInfo.mockReset();
    mocks.logError.mockReset();
    mocks.getElectronLogFile.mockReset();
    mocks.getElectronLogFile.mockReturnValue({ path: mocks.appLogPath });
    mocks.confirmUpdate.mockReset();
    mocks.installUpdate.mockReset();
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("returns the Electron main-process log tail from electron-log", () => {
    writeFileSync(
      mocks.appLogPath,
      Array.from({ length: 105 }, (_value, index) => `main log line ${index + 1}`).join("\n"),
    );
    const handlers = createDaemonCommandHandlers();

    expect(handlers.desktop_app_logs()).toEqual({
      logPath: mocks.appLogPath,
      contents: Array.from({ length: 100 }, (_value, index) => `main log line ${index + 6}`).join(
        "\n",
      ),
    });
  });

  it.each(["stopped", "not_running"] as const)(
    "restores the captured built-in daemon on cancellation only when the stop returned %s",
    async (action) => {
      const capturedHome = mocks.paseoHome;
      mkdirSync(capturedHome);
      const instance = {
        pid: process.pid,
        startedAt: new Date(Date.now() - 1_000).toISOString(),
        hostname: hostname(),
        uid: process.getuid?.() ?? 0,
        listen: "127.0.0.1:6799",
        desktopManaged: true,
      };
      const lockPath = path.join(capturedHome, "paseo.pid");
      writeFileSync(lockPath, JSON.stringify(instance));
      mocks.confirmUpdate.mockImplementation(async () => {
        mocks.paseoHome = path.join(fixtureRoot, "other-home");
        return true;
      });
      mocks.settings = { ...DEFAULT_DESKTOP_SETTINGS, officialUpdatesEnabled: true };
      mocks.stopDaemonInstance.mockImplementation(async () => {
        expect(isManualUpdateHandoffInProgress()).toBe(true);
        await Promise.resolve();
        mocks.settings = { ...DEFAULT_DESKTOP_SETTINGS, officialUpdatesEnabled: false };
        rmSync(lockPath);
        return { action, pid: instance.pid, forced: false, usedLifecycleRpc: false };
      });
      const restored = { ...instance, startedAt: new Date().toISOString() };
      mocks.startDaemonInstance.mockImplementation(async () => {
        writeFileSync(lockPath, JSON.stringify(restored));
        return { instance: restored, spawned: true };
      });
      mocks.installUpdate.mockImplementation(async (_input, beforeQuit) => {
        const shutdown = await beforeQuit({ version: "1.2.4" });
        expect(mocks.settings.officialUpdatesEnabled).toBe(false);
        await shutdown?.restore();
        return { installed: false };
      });

      expect(await createDaemonCommandHandlers().install_app_update()).toEqual({
        installed: false,
      });
      expect(mocks.confirmUpdate).toHaveBeenCalledExactlyOnceWith({ version: "1.2.4" }, "Cancel");
      expect(mocks.stopDaemonInstance).toHaveBeenCalledExactlyOnceWith(
        capturedHome,
        expect.objectContaining({
          instance: expect.objectContaining({ pid: instance.pid, startedAt: instance.startedAt }),
        }),
      );
      expect(mocks.stopDaemonInstance.mock.calls[0]?.[1]).toHaveProperty("resumeAgents", true);
      expect(mocks.startDaemonInstance.mock.calls).toEqual(
        action === "stopped"
          ? [[expect.objectContaining({ home: capturedHome, desktopManaged: true })]]
          : [],
      );
      expect(isManualUpdateHandoffInProgress()).toBe(false);
    },
  );

  it("blocks daemon starts until a manual update that found no daemon has failed", async () => {
    mkdirSync(mocks.paseoHome);
    const handlers = createDaemonCommandHandlers();
    mocks.installUpdate.mockImplementation(async (_input, beforeQuit) => {
      const shutdown = await beforeQuit({ version: "1.2.4" });
      if (!shutdown) throw new Error("Expected the update to hold the daemon launch lock");
      await shutdown.beforeHandoff();
      await expect(handlers.start_desktop_daemon()).rejects.toThrow("stopped for an app update");
      await expect(handlers.restart_desktop_daemon()).rejects.toThrow("stopped for an app update");
      await shutdown.restore();
      return { installed: false };
    });

    expect(await handlers.install_app_update()).toEqual({ installed: false });
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
    const next = await prepareBuiltInDaemonForUpdate(approvedUpdate);
    await next.restore();
  });

  it("defers an ordinary update when a daemon is present, then permits a stop for manual install", async () => {
    mkdirSync(mocks.paseoHome);
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    const instance = {
      pid: process.pid,
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
    };
    writeFileSync(lockPath, JSON.stringify(instance));
    mocks.settings = { ...DEFAULT_DESKTOP_SETTINGS, officialUpdatesEnabled: true };

    expect(await prepareBuiltInDaemonForUpdate(approvedUpdate, "defer")).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();

    mocks.confirmUpdate.mockResolvedValue(true);
    mocks.stopDaemonInstance.mockImplementation(async () => {
      rmSync(lockPath);
      return { action: "stopped", pid: instance.pid, forced: false, usedLifecycleRpc: false };
    });
    mocks.installUpdate.mockImplementation(async (_input, beforeQuit) => {
      const shutdown = await beforeQuit({ version: "1.2.4" });
      if (!shutdown) throw new Error("Expected a stopped daemon before installation");
      await shutdown.beforeHandoff();
      return { installed: true };
    });
    expect(await createDaemonCommandHandlers().install_app_update()).toEqual({ installed: true });
    expect(existsSync(lockPath)).toBe(false);
    expect(mocks.stopDaemonInstance).toHaveBeenCalledOnce();
  });

  it.each([
    { scenario: "cancelled update", reopenedVersion: "1.2.3", expectedAgent: "running-agent" },
    { scenario: "successful update", reopenedVersion: "1.2.4", expectedAgent: null },
    {
      scenario: "old version with newer recovery",
      reopenedVersion: "1.2.3",
      expectedAgent: "newer-agent",
    },
    {
      scenario: "new version with newer recovery",
      reopenedVersion: "1.2.4",
      expectedAgent: "newer-agent",
    },
    { scenario: "blocked restore", reopenedVersion: "1.2.3", expectedAgent: "running-agent" },
  ])(
    "starts desktop after installer handoff: $scenario",
    async ({ scenario, reopenedVersion, expectedAgent }) => {
      const home = mocks.paseoHome;
      mkdirSync(home);
      const lockPath = path.join(home, "paseo.pid");
      const markerPath = path.join(home, "restart-recovery-once.json");
      const recoveryPath = path.join(home, "app-update-recovery.json");
      const instance = {
        pid: process.pid,
        startedAt: new Date(Date.now() - 1_000).toISOString(),
        hostname: hostname(),
        uid: process.getuid?.() ?? 0,
        listen: "127.0.0.1:6799",
        desktopManaged: true,
      };
      writeFileSync(lockPath, JSON.stringify(instance));
      mocks.settings = { ...DEFAULT_DESKTOP_SETTINGS, officialUpdatesEnabled: true };
      mocks.confirmUpdate.mockResolvedValue(true);
      const storage = new AgentStorage(path.join(home, "agents"), createTestLogger());
      for (const [id, lastStatus] of [
        ["running-agent", "running"],
        ["newer-agent", "idle"],
      ] as const) {
        await storage.upsert(
          parseStoredAgentRecord({
            id,
            lastStatus,
            provider: "codex",
            cwd: home,
            createdAt: instance.startedAt,
            updatedAt: instance.startedAt,
          }),
        );
      }
      const dispatch = vi.fn(async (_id: string, _prompt: string) => {});
      const report = vi.fn();
      const createRecovery = () =>
        createRestartRecovery({
          storage,
          oneShotMarkerPath: markerPath,
          settings: () => ({ enabled: false, prompt: "Continue." }),
          eligible: async () => true,
          dispatch,
          report,
        });
      mocks.stopDaemonInstance.mockImplementation(async () => {
        await createRecovery().captureRunningAgents({ force: true });
        rmSync(lockPath);
        return { action: "stopped", pid: instance.pid, forced: false, usedLifecycleRpc: true };
      });
      const service = createAppUpdateService({
        isPackaged: () => true,
        isUpdatesEnabled: async () => true,
        now: () => 0,
        bucket: async () => 0,
        runtime: {
          configure: ({ onUpdateDownloaded }) => onUpdateDownloaded(approvedUpdate),
          checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: approvedUpdate }),
          downloadUpdate: async () => {},
          quitAndInstall: async (request, beforeHandoff) => {
            expect(request).toEqual({
              targetVersion: "1.2.4",
              isSilent: false,
              isForceRunAfter: true,
            });
            await beforeHandoff?.();
            expect(existsSync(markerPath)).toBe(false);
          },
        },
      });
      mocks.installUpdate.mockImplementation(service.downloadAndInstallUpdate);

      expect(await createDaemonCommandHandlers().install_app_update()).toEqual({
        installed: true,
        version: "1.2.4",
        message: "Update downloaded. The app will restart shortly.",
      });
      expect(existsSync(markerPath)).toBe(false);
      expect(JSON.parse(readFileSync(recoveryPath, "utf8"))).toEqual({
        sourceVersion: "1.2.3",
        targetVersion: "1.2.4",
        marker: '{"version":2,"agentIds":["running-agent"]}',
      });
      if (expectedAgent === "newer-agent") {
        writeFileSync(markerPath, '{"version":2,"agentIds":["newer-agent"]}');
      }

      // The installer started and the app exited. A fresh desktop process has only the disk state.
      mocks.appVersion = reopenedVersion;
      vi.resetModules();
      const { createDaemonCommandHandlers: createReopenedHandlers } =
        await import("./daemon-manager");
      const expectedMarker = expectedAgent ? `{"version":2,"agentIds":["${expectedAgent}"]}` : null;
      const reopened = createReopenedHandlers();
      if (scenario === "blocked restore") {
        mkdirSync(markerPath);
        await expect(reopened.start_desktop_daemon()).rejects.toThrow();
        expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
        expect(existsSync(recoveryPath)).toBe(true);
        rmSync(markerPath, { recursive: true });
      }
      mocks.startDaemonInstance.mockImplementation(async () => {
        const recovery = createRecovery();
        expect(existsSync(markerPath) ? readFileSync(markerPath, "utf8") : null).toBe(
          mocks.startDaemonInstance.mock.calls.length === 1 ? expectedMarker : null,
        );
        await recovery.prepareStartup();
        recovery.resumePending();
        const signal = new AbortController().signal;
        await recovery.waitForResume("running-agent", signal);
        await recovery.waitForResume("newer-agent", signal);
      });
      await reopened.start_desktop_daemon();
      expect(existsSync(markerPath)).toBe(false);
      expect(existsSync(recoveryPath)).toBe(false);
      expect(dispatch.mock.calls).toEqual(expectedAgent ? [[expectedAgent, "Continue."]] : []);

      // The old recovery must not replay, even if the source version is opened again.
      mocks.appVersion = "1.2.3";
      await reopened.start_desktop_daemon();
      expect(mocks.startDaemonInstance).toHaveBeenCalledTimes(2);
      expect(dispatch.mock.calls).toEqual(expectedAgent ? [[expectedAgent, "Continue."]] : []);
      expect(report).not.toHaveBeenCalled();
    },
  );

  it.each<{
    outcome: string;
    shouldRestore: boolean;
    zipErrorCode?: number;
    quitsDuringPreparation?: boolean;
  }>([
    { outcome: "unavailable", shouldRestore: true },
    { outcome: "failed HTTP download", shouldRestore: true },
    { outcome: "native download timeout", shouldRestore: true },
    { outcome: "native download disconnected", shouldRestore: true },
    { outcome: "missing application bundle", shouldRestore: true },
    { outcome: "failed ZIP extraction", shouldRestore: true, zipErrorCode: 1 },
    { outcome: "unrecognized ZIP error code", shouldRestore: false, zipErrorCode: 2 },
    {
      outcome: "failed ZIP extraction during quit",
      shouldRestore: false,
      zipErrorCode: 1,
      quitsDuringPreparation: true,
    },
    { outcome: "no native terminal event", shouldRestore: false },
    { outcome: "error", shouldRestore: false },
    { outcome: "ready", shouldRestore: false },
    { outcome: "other feed then unavailable", shouldRestore: false },
    { outcome: "unavailable after feed replacement", shouldRestore: false },
    { outcome: "unavailable during quit", shouldRestore: false, quitsDuringPreparation: true },
  ])(
    "handles a timed-out manual macOS update: $outcome",
    async ({ outcome, shouldRestore, zipErrorCode, quitsDuringPreparation }) => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        vi.resetModules();
        const updater = await vi.importActual<typeof import("../features/auto-updater")>(
          "../features/auto-updater",
        );
        mocks.installUpdate.mockImplementation(updater.downloadAndInstallUpdate);
        const home = mocks.paseoHome;
        mkdirSync(home);
        const lockPath = path.join(home, "paseo.pid");
        const markerPath = path.join(home, "restart-recovery-once.json");
        const recoveryPath = path.join(home, "app-update-recovery.json");
        const instance = {
          pid: process.pid,
          startedAt: new Date(Date.now() - 1_000).toISOString(),
          hostname: hostname(),
          uid: process.getuid?.() ?? 0,
          listen: `127.0.0.1:${49152 + (process.pid % 16384)}`,
          desktopManaged: true,
        };
        writeFileSync(lockPath, JSON.stringify(instance));
        mocks.settings = { ...DEFAULT_DESKTOP_SETTINGS, officialUpdatesEnabled: true };
        mocks.confirmUpdate.mockResolvedValue(true);
        const storage = new AgentStorage(path.join(home, "agents"), createTestLogger());
        await storage.upsert(
          parseStoredAgentRecord({
            id: "running-agent",
            lastStatus: "running",
            provider: "codex",
            cwd: home,
            createdAt: instance.startedAt,
            updatedAt: instance.startedAt,
          }),
        );
        const dispatch = vi.fn(async (_id: string, _prompt: string) => {});
        const recovery = () =>
          createRestartRecovery({
            storage,
            oneShotMarkerPath: markerPath,
            settings: () => ({ enabled: false, prompt: "Continue." }),
            eligible: async () => true,
            dispatch,
            report: vi.fn(),
          });
        mocks.stopDaemonInstance.mockImplementation(async () => {
          await recovery().captureRunningAgents({ force: true });
          rmSync(lockPath);
          return { action: "stopped", pid: instance.pid, forced: false, usedLifecycleRpc: true };
        });
        const parkedRecord = {
          sourceVersion: "1.2.3",
          targetVersion: "1.2.4",
          marker: '{"version":2,"agentIds":["running-agent"]}',
        };
        mocks.startDaemonInstance.mockImplementation(async () => {
          expect(isManualUpdateHandoffInProgress()).toBe(true);
          expect(readFileSync(markerPath, "utf8")).toBe(parkedRecord.marker);
          expect(existsSync(recoveryPath)).toBe(false);
          const startupRecovery = recovery();
          await startupRecovery.prepareStartup();
          startupRecovery.resumePending();
          await startupRecovery.waitForResume("running-agent", new AbortController().signal);
          const restored = { ...instance, startedAt: new Date().toISOString() };
          writeFileSync(lockPath, JSON.stringify(restored));
          return { instance: restored, spawned: true };
        });
        updateSource.checkForUpdates.mockResolvedValue({
          isUpdateAvailable: true,
          updateInfo: approvedUpdate,
        });
        updateSource.downloadUpdate.mockImplementation(async () => {
          updateSource.emit("update-downloaded", approvedUpdate);
        });

        const quitting = Promise.withResolvers<boolean>();
        const exit = vi.fn();
        const lifecycle = createQuitLifecycle({
          app: { exit },
          closeTransportSessions: vi.fn(),
          stopDesktopManagedDaemonIfNeeded: async () => false,
          installAppUpdateOnQuit: () => quitting.promise,
          createUpdateDeadlineSignal: () => new AbortController().signal,
          isManualUpdateHandoffInProgress,
          onStopError: vi.fn(),
          onUpdateError: vi.fn(),
        });
        const handlers = createDaemonCommandHandlers(undefined, lifecycle.isQuitting);
        const install = handlers.install_app_update();
        await vi.waitFor(() => expect(nativeUpdater.checkForUpdates).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await install).toMatchObject({
          installed: false,
          message: expect.stringContaining("macOS may install the update on exit"),
        });
        expect(mocks.confirmUpdate).toHaveBeenCalledExactlyOnceWith(approvedUpdate, "Cancel");
        expect(JSON.parse(readFileSync(recoveryPath, "utf8"))).toEqual(parkedRecord);
        expect(existsSync(markerPath)).toBe(false);
        expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
        await expect(handlers.restart_desktop_daemon()).rejects.toThrow(
          "stopped for an app update",
        );

        if (quitsDuringPreparation) {
          lifecycle.handleBeforeQuit({ preventDefault: vi.fn() });
          expect(lifecycle.isQuitting()).toBe(true);
          expect(exit).not.toHaveBeenCalled();
        }
        if (outcome === "error") {
          nativeUpdater.emit("error", new Error("Native preparation failed"));
        } else if (outcome === "failed HTTP download") {
          nativeUpdater.emit(
            "error",
            Object.assign(new Error("Update download failed"), {
              domain: "SQRLUpdaterErrorDomain",
              code: 5,
            }),
          );
        } else if (
          outcome === "native download timeout" ||
          outcome === "native download disconnected"
        ) {
          nativeUpdater.emit(
            "error",
            Object.assign(new Error(outcome), {
              domain: "NSURLErrorDomain",
              code: outcome === "native download timeout" ? -1001 : -1005,
            }),
          );
        } else if (outcome === "missing application bundle") {
          nativeUpdater.emit(
            "error",
            Object.assign(new Error("Could not locate update bundle"), {
              domain: "SQRLUpdaterErrorDomain",
              code: 2,
            }),
          );
        } else if (zipErrorCode !== undefined) {
          nativeUpdater.emit(
            "error",
            Object.assign(new Error("ditto: No space left on device"), {
              domain: "SQRLZipArchiverErrorDomain",
              code: zipErrorCode,
            }),
          );
        } else if (outcome === "ready") {
          nativeUpdater.emit(
            "update-downloaded",
            {},
            "",
            "",
            new Date(0),
            "http://127.0.0.1:32100/update.zip",
          );
        } else if (outcome !== "no native terminal event") {
          if (outcome === "unavailable after feed replacement") {
            nativeUpdater.getFeedURL.mockReturnValue("http://127.0.0.1:32101");
          }
          if (outcome === "other feed then unavailable") {
            nativeUpdater.emit(
              "update-downloaded",
              {},
              "",
              "",
              new Date(0),
              "http://127.0.0.1:32101/update.zip",
            );
          }
          nativeUpdater.emit("update-not-available");
        }
        if (outcome === "no native terminal event") {
          await vi.advanceTimersByTimeAsync(30_000);
        } else {
          // Native notifications may repeat, but a timed-out attempt can only restore once.
          nativeUpdater.emit("update-not-available");
          await vi.advanceTimersByTimeAsync(0);
        }

        if (shouldRestore) {
          await vi.waitFor(() => {
            expect(mocks.startDaemonInstance).toHaveBeenCalledOnce();
            expect(isManualUpdateHandoffInProgress()).toBe(false);
          });
          expect(dispatch).toHaveBeenCalledExactlyOnceWith("running-agent", "Continue.");
          expect(existsSync(markerPath)).toBe(false);
          expect(existsSync(recoveryPath)).toBe(false);
          mocks.runExternalCliJsonCommand.mockImplementation(async (args: string[]) =>
            args[1] === "status"
              ? {
                  ...JSON.parse(readFileSync(lockPath, "utf8")),
                  localDaemon: "running",
                  daemonVersion: "1.2.3",
                }
              : {},
          );
          await expect(handlers.restart_desktop_daemon()).resolves.toMatchObject({
            status: "running",
            desktopManaged: true,
            listen: instance.listen,
          });
          expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledWith([
            "daemon",
            "restart",
            "--home",
            home,
            "--json",
          ]);
          expect(mocks.startDaemonInstance).toHaveBeenCalledOnce();
        } else {
          expect(isManualUpdateHandoffInProgress()).toBe(false);
          expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
          expect(dispatch).not.toHaveBeenCalled();
          expect(JSON.parse(readFileSync(recoveryPath, "utf8"))).toEqual(parkedRecord);
          await expect(handlers.restart_desktop_daemon()).rejects.toThrow(
            "stopped for an app update",
          );
        }
        expect(updateSource.quitAndInstall).not.toHaveBeenCalled();
        quitting.resolve(false);
        if (quitsDuringPreparation) {
          await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
        }
      } finally {
        Object.defineProperty(process, "platform", platform);
        vi.useRealTimers();
        nativeUpdater.checkForUpdates.mockReset();
        nativeUpdater.getFeedURL.mockReset();
        nativeUpdater.removeAllListeners();
        updateSource.checkForUpdates.mockReset();
        updateSource.downloadUpdate.mockReset();
        updateSource.quitAndInstall.mockReset();
        updateSource.removeAllListeners();
      }
    },
  );

  it.each([true, false])(
    "takes the ordinary quit path with a daemon running: %s",
    async (running) => {
      const home = mocks.paseoHome;
      mkdirSync(home);
      const lockPath = path.join(home, "paseo.pid");
      if (running) {
        writeFileSync(
          lockPath,
          JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
            hostname: hostname(),
            uid: process.getuid?.() ?? 0,
            listen: "127.0.0.1:6799",
            desktopManaged: true,
          }),
        );
      }
      mocks.stopDaemonInstance.mockImplementation(async () => {
        rmSync(lockPath);
        return { action: "stopped", pid: process.pid, forced: false, usedLifecycleRpc: true };
      });
      const { promise: exited, resolve: exit } = Promise.withResolvers<number>();
      const prepareUpdate = vi.fn(prepareBuiltInDaemonForUpdate);
      const quit = createQuitLifecycle({
        app: { exit },
        closeTransportSessions: vi.fn(),
        stopDesktopManagedDaemonIfNeeded: () =>
          stopDesktopManagedDaemonOnQuitIfNeeded({
            settingsStore: { get: async () => DEFAULT_DESKTOP_SETTINGS },
            isDesktopManagedDaemonRunning: isDesktopManagedDaemonPresentSync,
            stopDaemon: (reason) =>
              stopDesktopDaemon(reason, undefined, { includePreviousLaunch: true }),
            showShutdownFeedback: vi.fn(),
          }),
        prepareDaemonForAppUpdate: prepareUpdate,
        installAppUpdateOnQuit: async () => false,
        createUpdateDeadlineSignal: () => new AbortController().signal,
        onStopError: vi.fn(),
        onUpdateError: vi.fn(),
      });
      quit.handleBeforeQuit({ preventDefault: vi.fn() });
      expect(await exited).toBe(0);
      expect(prepareUpdate).not.toHaveBeenCalled();
      expect(mocks.stopDaemonInstance).toHaveBeenCalledTimes(running ? 1 : 0);
      expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
      expect(existsSync(path.join(home, "app-update-recovery.json"))).toBe(false);
      expect(existsSync(path.join(home, "restart-recovery-once.json"))).toBe(false);
    },
  );

  it.each([
    "handoff",
    "preserve until next launch",
    "rollback",
    "restart failure",
    "recovery write failure",
    "unsupported",
    "existing",
    "missing",
    "replaced",
  ] as const)("preserves recovery-record ownership on %s", async (outcome) => {
    mkdirSync(mocks.paseoHome);
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    const markerPath = path.join(mocks.paseoHome, "restart-recovery-once.json");
    const recoveryPath = path.join(mocks.paseoHome, "app-update-recovery.json");
    const instance = {
      pid: process.pid,
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
    };
    const marker = JSON.stringify({ version: 2, agentIds: ["running-agent"] });
    const otherMarker = JSON.stringify({ version: 2, agentIds: ["another-agent"] });
    writeFileSync(lockPath, JSON.stringify(instance));
    if (outcome === "existing") {
      writeFileSync(markerPath, otherMarker);
      await expect(prepareBuiltInDaemonForUpdate(approvedUpdate)).rejects.toThrow(
        "record is pending",
      );
      expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
      expect(readFileSync(markerPath, "utf8")).toBe(otherMarker);
      return;
    }
    mocks.stopDaemonInstance.mockImplementation(async (_home, options) => {
      if (outcome === "unsupported" && options.resumeAgents) {
        throw new ExternalCliCommandError("Recovery unavailable", {
          code: "AGENT_RESUME_ON_STOP_UNSUPPORTED",
        });
      }
      // Simulate an unrelated recovery record appearing during an unsupported stop.
      if (outcome !== "missing") {
        writeFileSync(markerPath, options.resumeAgents ? marker : otherMarker);
      }
      rmSync(lockPath);
      return { action: "stopped", pid: instance.pid, forced: false, usedLifecycleRpc: true };
    });
    const restored = { ...instance, startedAt: new Date().toISOString() };
    mocks.startDaemonInstance.mockImplementation(async () => {
      if (outcome === "restart failure") {
        expect(readFileSync(markerPath, "utf8")).toBe(marker);
        throw new Error("Daemon startup failed");
      }
      if (
        outcome === "rollback" ||
        outcome === "unsupported" ||
        outcome === "recovery write failure"
      ) {
        expect(readFileSync(markerPath, "utf8")).toBe(
          outcome === "unsupported" ? otherMarker : marker,
        );
        // The old daemon consumes the one-shot record at startup.
        rmSync(markerPath);
      } else {
        expect(existsSync(markerPath)).toBe(false);
      }
      writeFileSync(lockPath, JSON.stringify(restored));
      return { instance: restored, spawned: true };
    });

    const shutdown = await prepareBuiltInDaemonForUpdate(approvedUpdate);
    expect(shutdown).toBeDefined();
    if (outcome === "missing") {
      await expect(shutdown?.beforeHandoff()).rejects.toThrow("recovery record is missing");
      return;
    }
    expect(existsSync(markerPath)).toBe(true);
    if (outcome === "recovery write failure") {
      mkdirSync(recoveryPath);
      await expect(shutdown?.beforeHandoff()).rejects.toThrow();
      expect(readFileSync(markerPath, "utf8")).toBe(marker);
      await shutdown?.restore();
      expect(mocks.startDaemonInstance).toHaveBeenCalledOnce();
      expect(existsSync(markerPath)).toBe(false);
      return;
    }
    if (outcome === "replaced") {
      writeFileSync(`${markerPath}.tmp`, otherMarker);
      renameSync(`${markerPath}.tmp`, markerPath);
      await expect(shutdown?.beforeHandoff()).rejects.toThrow("Daemon recovery changed");
      expect(readFileSync(markerPath, "utf8")).toBe(otherMarker);
      return;
    }
    await shutdown?.beforeHandoff();
    expect(existsSync(markerPath)).toBe(outcome === "unsupported");
    if (outcome === "handoff" || outcome === "preserve until next launch") {
      const handlers = createDaemonCommandHandlers();
      await expect(handlers.start_desktop_daemon()).rejects.toThrow("stopped for an app update");
      await expect(handlers.restart_desktop_daemon()).rejects.toThrow("stopped for an app update");
      if (outcome === "preserve until next launch") {
        expect(JSON.parse(readFileSync(recoveryPath, "utf8"))).toEqual({
          sourceVersion: "1.2.3",
          targetVersion: "1.2.4",
          marker,
        });
        expect(existsSync(lockPath)).toBe(false);
      }
      expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
    } else if (outcome === "restart failure") {
      await expect(shutdown?.restore()).rejects.toThrow("Daemon startup failed");
      expect(readFileSync(markerPath, "utf8")).toBe(marker);
    } else {
      await shutdown?.restore();
      expect(mocks.startDaemonInstance).toHaveBeenCalledOnce();
      expect(existsSync(markerPath)).toBe(false);
    }
  });

  it("exposes updater diagnostics through the desktop command boundary", () => {
    const diagnostics = createDaemonCommandHandlers().desktop_update_diagnostics();

    expect(diagnostics).toMatchObject({
      platform: process.platform,
      currentVersion: "1.2.3",
    });
  });

  it("reports a stopped daemon without launching the CLI when no local daemon runs", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "server-id"), "srv_existing\n");
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      home: mocks.paseoHome,
      pid: null,
      startedAt: null,
      listen: null,
      hostname: null,
      localDaemon: "stopped",
      desktopManaged: false,
      connectedDaemon: "not_probed",
    });

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "stopped", pid: null });
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
  });

  it("recognizes a desktop-managed daemon left running by a previous desktop launch", () => {
    expect(isDesktopManagedDaemonPresentSync()).toBe(false);

    mkdirSync(mocks.paseoHome);
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, desktopManaged: true }));
    expect(isDesktopManagedDaemonRunningSync()).toBe(false);
    expect(isDesktopManagedDaemonPresentSync()).toBe(true);

    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, desktopManaged: false }));
    expect(isDesktopManagedDaemonPresentSync()).toBe(false);

    writeFileSync(lockPath, "garbage");
    expect(isDesktopManagedDaemonPresentSync()).toBe(false);
  });

  it("reports an errored daemon when the local daemon state cannot be read", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "paseo.pid"), "garbage");

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "errored", pid: null });
    expect(status.error).toBeTruthy();
  });

  it("returns a local credential only for its live managed daemon listen", async () => {
    mkdirSync(mocks.paseoHome);
    const token = "a".repeat(43);
    writeFileSync(path.join(mocks.paseoHome, "local-credential"), `${token}\n`, { mode: 0o600 });
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    const handler = createDaemonCommandHandlers().desktop_local_credential;
    expect(await handler({ listen: "localhost:6799" })).toBe(token);
    expect(await handler({ listen: "remote:6799" })).toBeNull();
    writeFileSync(lockPath, JSON.stringify({ ...lock, desktopManaged: false }));
    expect(await handler({ listen: "localhost:6799" })).toBeNull();
  });

  it("stops a desktop-managed daemon from a previous launch only for resume-agents reasons and never stops a manual CLI daemon", async () => {
    mkdirSync(mocks.paseoHome);
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "running",
      pid: lock.pid,
      startedAt: lock.startedAt,
      listen: lock.listen,
      desktopManaged: true,
    });
    mocks.stopDaemonInstance.mockResolvedValue({
      action: "stopped",
      pid: lock.pid,
      forced: false,
      usedLifecycleRpc: true,
    });

    for (const reason of ["quit", "settings", "host_remove", "manual_ipc"] as const) {
      await stopDesktopDaemon(reason);
    }
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();

    await stopDesktopDaemon("quit", undefined, { includePreviousLaunch: true });
    expect(mocks.stopDaemonInstance).toHaveBeenCalledExactlyOnceWith(
      mocks.paseoHome,
      expect.objectContaining({ instance: expect.objectContaining({ pid: lock.pid }) }),
    );
    mocks.stopDaemonInstance.mockClear();

    for (const reason of ["quit_preserve_work", "app_update", "version_mismatch"] as const) {
      await stopDesktopDaemon(reason);
    }
    expect(mocks.stopDaemonInstance).toHaveBeenCalledTimes(3);

    mocks.stopDaemonInstance.mockClear();
    writeFileSync(lockPath, JSON.stringify({ ...lock, desktopManaged: false }));
    await stopDesktopDaemon("quit", undefined, { includePreviousLaunch: true });
    for (const reason of [
      "quit",
      "quit_preserve_work",
      "app_update",
      "version_mismatch",
    ] as const) {
      await stopDesktopDaemon(reason);
    }
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
  });

  it("restarts a version-mismatched daemon from a previous desktop launch on start, but leaves a manual CLI daemon untouched", async () => {
    mkdirSync(mocks.paseoHome);
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: false,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "running",
      pid: lock.pid,
      startedAt: lock.startedAt,
      listen: lock.listen,
      daemonVersion: "0.15.0",
      desktopManaged: false,
    });

    const handlers = createDaemonCommandHandlers();
    await handlers.start_desktop_daemon();
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();

    writeFileSync(lockPath, JSON.stringify({ ...lock, desktopManaged: true }));
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "running",
      pid: lock.pid,
      startedAt: lock.startedAt,
      listen: lock.listen,
      daemonVersion: "0.15.0",
      desktopManaged: true,
    });
    mocks.stopDaemonInstance.mockResolvedValue({
      action: "stopped",
      pid: lock.pid,
      forced: false,
      usedLifecycleRpc: true,
    });
    mocks.startDaemonInstance.mockResolvedValue({ instance: lock });

    await handlers.start_desktop_daemon();
    expect(mocks.stopDaemonInstance).toHaveBeenCalledExactlyOnceWith(
      mocks.paseoHome,
      expect.objectContaining({
        keepTerminals: process.platform !== "win32",
        resumeAgents: true,
      }),
    );
    expect(mocks.startDaemonInstance).toHaveBeenCalledOnce();
  });
});

describe("desktop stops and terminals", () => {
  const reasons: DesktopDaemonStopReason[] = [
    "manual_ipc",
    "settings",
    "host_remove",
    "quit",
    "quit_preserve_work",
    "app_update",
    "version_mismatch",
    "restart",
  ];

  it("keeps terminals only for an app update or version-mismatch restart, never on Windows", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(reasons.filter((reason) => keepsTerminalsOnStop(reason, platform))).toEqual([
        "app_update",
        "version_mismatch",
      ]);
    }
    expect(reasons.filter((reason) => keepsTerminalsOnStop(reason, "win32"))).toEqual([]);
  });

  it("resumes agents only for a preserve-work quit or a restart with the bundled daemon", () => {
    expect(reasons.filter(resumesAgentsOnStop)).toEqual(["quit_preserve_work", "version_mismatch"]);
  });

  function stopHarness(runCliJson: (args: string[]) => Promise<unknown>) {
    const stops: Array<{ keepTerminals?: boolean; resumeAgents?: boolean }> = [];
    const logged: string[] = [];
    const instance = {
      pid: 4242,
      startedAt: "2026-10-21T00:00:00.000Z",
      hostname: "host",
      uid: 501,
      listen: "127.0.0.1:6799",
    };
    const stopInstance: NonNullable<
      Parameters<typeof stopCapturedDaemon>[0]["stopInstance"]
    > = async (_home, { requestShutdown, ...options } = {}) => {
      stops.push({
        keepTerminals: options.keepTerminals,
        ...("resumeAgents" in options ? { resumeAgents: options.resumeAgents } : {}),
      });
      await requestShutdown?.(instance);
      return { action: "stopped", pid: instance.pid, forced: false, usedLifecycleRpc: true };
    };
    return {
      stops,
      logged,
      input: {
        home: "/tmp/paseo-home",
        instance,
        stopInstance,
        runCliJson,
        log: (message: string) => logged.push(message),
      } as Omit<Parameters<typeof stopCapturedDaemon>[0], "reason" | "keepTerminals">,
    };
  }

  it("asks the daemon to keep its terminals and resume agents on an app update", async () => {
    const runCliJson = vi.fn().mockResolvedValue({ action: "shutdown_requested" });
    const harness = stopHarness(runCliJson);

    await stopCapturedDaemon({
      ...harness.input,
      reason: "app_update",
      keepTerminals: true,
      resumeAgents: true,
    });

    expect(harness.stops).toEqual([{ keepTerminals: true, resumeAgents: true }]);
    expect(runCliJson).toHaveBeenCalledExactlyOnceWith([
      "daemon",
      "stop",
      "--host",
      "127.0.0.1:6799",
      "--keep-terminals",
      "--resume-agents",
      "--json",
    ]);
  });

  it("asks the daemon to resume agents and close its terminals on a preserve-work quit", async () => {
    const runCliJson = vi.fn().mockResolvedValue({ action: "shutdown_requested" });
    const harness = stopHarness(runCliJson);

    await stopCapturedDaemon({
      ...harness.input,
      reason: "quit_preserve_work",
      keepTerminals: false,
      resumeAgents: true,
    });

    expect(harness.stops).toEqual([{ keepTerminals: false, resumeAgents: true }]);
    expect(runCliJson).toHaveBeenCalledExactlyOnceWith([
      "daemon",
      "stop",
      "--host",
      "127.0.0.1:6799",
      "--resume-agents",
      "--json",
    ]);
  });

  it("rejects a preserve-work quit without retrying when the daemon cannot resume agents", async () => {
    const error = new ExternalCliCommandError("refused", {
      code: "AGENT_RESUME_ON_STOP_UNSUPPORTED",
    });
    const runCliJson = vi.fn().mockRejectedValue(error);
    const harness = stopHarness(runCliJson);

    await expect(
      stopCapturedDaemon({
        ...harness.input,
        reason: "quit_preserve_work",
        keepTerminals: false,
        resumeAgents: true,
      }),
    ).rejects.toBe(error);
    expect(harness.stops).toEqual([{ keepTerminals: false, resumeAgents: true }]);
  });

  it.each(["app_update", "version_mismatch"] as const)(
    "keeps terminals on %s when the daemon cannot resume agents",
    async (reason) => {
      const runCliJson = vi
        .fn()
        .mockRejectedValueOnce(
          new ExternalCliCommandError("refused", {
            code: "AGENT_RESUME_ON_STOP_UNSUPPORTED",
            version: "0.16.0",
          }),
        )
        .mockResolvedValueOnce({ action: "shutdown_requested" });
      const harness = stopHarness(runCliJson);

      await stopCapturedDaemon({
        ...harness.input,
        reason,
        keepTerminals: true,
        resumeAgents: true,
      });

      expect(harness.stops).toEqual([
        { keepTerminals: true, resumeAgents: true },
        { keepTerminals: true },
      ]);
      expect(runCliJson).toHaveBeenCalledTimes(2);
      expect(runCliJson).toHaveBeenLastCalledWith([
        "daemon",
        "stop",
        "--host",
        "127.0.0.1:6799",
        "--keep-terminals",
        "--json",
      ]);
      expect(harness.logged).toEqual([
        "daemon v0.16.0 cannot resume agents on stop; stopping without agent resume",
      ]);
    },
  );

  it("drops unsupported terminal preservation before retrying agent resume", async () => {
    const runCliJson = vi
      .fn()
      .mockRejectedValueOnce(
        new ExternalCliCommandError("refused", { code: "TERMINALS_KEEP_UNSUPPORTED" }),
      )
      .mockRejectedValueOnce(
        new ExternalCliCommandError("refused", { code: "AGENT_RESUME_ON_STOP_UNSUPPORTED" }),
      )
      .mockResolvedValueOnce({ action: "shutdown_requested" });
    const harness = stopHarness(runCliJson);

    await stopCapturedDaemon({
      ...harness.input,
      reason: "app_update",
      keepTerminals: true,
      resumeAgents: true,
    });

    expect(harness.stops).toEqual([
      { keepTerminals: true, resumeAgents: true },
      { keepTerminals: false, resumeAgents: true },
      { keepTerminals: false },
    ]);
    expect(runCliJson).toHaveBeenNthCalledWith(2, [
      "daemon",
      "stop",
      "--host",
      "127.0.0.1:6799",
      "--resume-agents",
      "--json",
    ]);
    expect(runCliJson).toHaveBeenLastCalledWith([
      "daemon",
      "stop",
      "--host",
      "127.0.0.1:6799",
      "--json",
    ]);
  });

  it("stops a daemon without the capability with its terminals closed, and says so", async () => {
    const calls: string[][] = [];
    const harness = stopHarness(async (args) => {
      calls.push(args);
      if (args.includes("--keep-terminals")) {
        throw new ExternalCliCommandError("refused", {
          code: "TERMINALS_KEEP_UNSUPPORTED",
          version: "0.11.0",
        });
      }
      return { action: "shutdown_requested" };
    });

    await stopCapturedDaemon({ ...harness.input, reason: "app_update", keepTerminals: true });

    expect(harness.stops).toEqual([{ keepTerminals: true }, { keepTerminals: false }]);
    expect(calls[1]).toEqual(["daemon", "stop", "--host", "127.0.0.1:6799", "--json"]);
    expect(harness.logged).toContain(
      "daemon v0.11.0 cannot keep terminals; stopping it and closing them",
    );
  });

  it("does not retry a keep stop that failed for another reason", async () => {
    const harness = stopHarness(async () => {
      throw new ExternalCliCommandError("unreachable", { code: "DAEMON_UNREACHABLE" });
    });

    await expect(
      stopCapturedDaemon({ ...harness.input, reason: "app_update", keepTerminals: true }),
    ).rejects.toThrow("unreachable");
    expect(harness.stops).toEqual([{ keepTerminals: true }]);
  });
});
