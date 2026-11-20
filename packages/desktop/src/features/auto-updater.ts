import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, autoUpdater as electronAutoUpdater, BrowserWindow, dialog } from "electron";
import { UUID } from "builder-util-runtime";
import log from "electron-log/main";
import { autoUpdater } from "electron-updater";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import {
  createAppUpdateService,
  type AppUpdateCheckResult,
  type AppUpdateInstallRequest,
  type AppUpdateInstallResult,
  type AppUpdateRuntime,
  type AppUpdateRuntimeConfiguration,
  type AppUpdateTarget,
  type BeforeAppUpdateInstall,
  type RuntimeUpdateCheckResult,
  type RuntimeUpdateInfo,
} from "./app-update-service.js";
import {
  bucketFromStagingUserId,
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
} from "./app-update-rollout.js";

export {
  bucketFromStagingUserId,
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
  type AppUpdateCheckResult,
  type AppUpdateInstallResult,
};

let cachedStagingUserIdPromise: Promise<string> | null = null;
let macUpdateQuitInProgress = false;

const UPDATE_CHANNEL_NOT_PUBLISHED_CODE = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
const QUIT_UPDATE_HANDOFF_TIMEOUT_MS = 5_000;

interface AppUpdateLogSink {
  info(message: string, details: object): void;
}

interface AppUpdateCheckLogDetails {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
}

interface AppUpdateCheckCompletedLogDetails extends AppUpdateCheckLogDetails {
  targetVersion: string;
  hasUpdate: boolean;
  readyToInstall: boolean;
  errorMessage: string | null;
}

export function createAppUpdateLifecycleLogger(logger: AppUpdateLogSink) {
  return {
    checkStarted(details: AppUpdateCheckLogDetails): void {
      logger.info("[auto-updater] check started", details);
    },
    checkCompleted(details: AppUpdateCheckCompletedLogDetails): void {
      logger.info("[auto-updater] check completed", details);
    },
    updateAvailable(targetVersion: string): void {
      logger.info("[auto-updater] update available", { targetVersion });
    },
    updateDownloaded(targetVersion: string): void {
      logger.info("[auto-updater] update downloaded", { targetVersion });
    },
    downloadRequested(targetVersion: string): void {
      logger.info("[auto-updater] download requested", { targetVersion });
    },
    quitAndInstallRequested(details: AppUpdateInstallRequest): void {
      logger.info("[auto-updater] quitAndInstall requested", details);
    },
  };
}

const updateLifecycleLog = createAppUpdateLifecycleLogger(log);

function isUpdateChannelNotPublished(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UPDATE_CHANNEL_NOT_PUBLISHED_CODE
  );
}

export function shouldAdmitToRollout(args: {
  channel: AppReleaseChannel;
  rolloutHours: number | undefined;
  releaseDate: string | undefined;
  now: number;
  bucket: number;
}): boolean {
  return shouldAdmitAppUpdate({ ...args, intent: "automatic" });
}

export async function resolveStagingUserId(filePath: string): Promise<string> {
  try {
    const id = (await readFile(filePath, "utf8")).trim();
    if (UUID.check(id)) {
      return id;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[auto-updater] Couldn't read staging user ID, creating a blank one: ${error}`);
    }
  }

  const id = UUID.v5(randomBytes(4096), UUID.OID);

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, id);
  } catch (error) {
    console.warn(`[auto-updater] Couldn't write out staging user ID: ${error}`);
  }

  return id;
}

export function getStagingUserId(): Promise<string> {
  if (cachedStagingUserIdPromise == null) {
    cachedStagingUserIdPromise = resolveStagingUserId(
      path.join(app.getPath("userData"), ".updaterId"),
    );
  }
  return cachedStagingUserIdPromise;
}

export function shouldInstallAppUpdateOnQuit(input: {
  platform: NodeJS.Platform;
  isAppImage: boolean;
}): boolean {
  // AppImage's no-relaunch install path blocks while launching the replacement
  // binary, which can hang after the running file has already been replaced.
  return !(input.platform === "linux" && input.isAppImage);
}

async function isOfficialUpdatesEnabled(): Promise<boolean> {
  return (await getDesktopSettingsStore().get()).officialUpdatesEnabled;
}

class ElectronAppUpdateRuntime implements AppUpdateRuntime {
  private configured = false;
  private macDownloadedInfo: RuntimeUpdateInfo | null = null;
  private macNativeReady = false;
  private onUpdateDownloaded?: AppUpdateRuntimeConfiguration["onUpdateDownloaded"];

  configure(input: AppUpdateRuntimeConfiguration): void {
    this.onUpdateDownloaded = input.onUpdateDownloaded;
    // Download explicitly so a setting change during a network check is respected.
    autoUpdater.autoDownload = false;
    autoUpdater.autoRunAppAfterInstall = true;
    // Paseo revalidates the current manifest before explicitly installing on quit.
    // Electron's built-in handler would install an older download without checking
    // whether a newer release has superseded it.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = input.releaseChannel === "beta";
    autoUpdater.channel = input.releaseChannel === "beta" ? "beta" : "latest";
    autoUpdater.allowDowngrade = false;
    autoUpdater.isUserWithinRollout = async (info) => {
      try {
        return await input.shouldAdmitUpdate(info as RuntimeUpdateInfo);
      } catch {
        return true;
      }
    };

    if (this.configured) return;
    this.configured = true;

    // electron-updater logs every emitted error before consumers can classify it.
    // Paseo reports genuine check, runtime, and install failures through the
    // callbacks below, so leave internal error logging disabled to avoid both
    // duplicate logs and expected missing-channel noise.
    const updaterLogger = autoUpdater.logger;
    autoUpdater.logger = {
      debug: updaterLogger?.debug ? (message) => updaterLogger.debug?.(message) : undefined,
      error: () => undefined,
      info: (message) => updaterLogger?.info(message),
      warn: (message) => updaterLogger?.warn(message),
    };

    autoUpdater.on("update-available", (info) => {
      const updateInfo = info as RuntimeUpdateInfo;
      updateLifecycleLog.updateAvailable(updateInfo.version);
      input.onUpdateAvailable(updateInfo);
    });
    autoUpdater.on("update-downloaded", (info) => {
      const updateInfo = info as RuntimeUpdateInfo;
      if (process.platform === "darwin") {
        this.macDownloadedInfo = updateInfo;
        this.macNativeReady = false;
      }
      updateLifecycleLog.updateDownloaded(updateInfo.version);
      this.onUpdateDownloaded?.(updateInfo);
    });
    autoUpdater.on("error", (error) => {
      if (isUpdateChannelNotPublished(error)) return;
      input.onError(error);
    });
  }

  async checkForUpdates(): Promise<RuntimeUpdateCheckResult | null> {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) return null;
      if (result.isUpdateAvailable) {
        // electron-updater reports download failures through its error event.
        void this.downloadUpdate(result.updateInfo.version).catch(() => undefined);
      }
      return {
        isUpdateAvailable: result.isUpdateAvailable,
        updateInfo: result.updateInfo as RuntimeUpdateInfo,
      };
    } catch (error) {
      if (isUpdateChannelNotPublished(error)) return null;
      throw error;
    }
  }

  async downloadUpdate(targetVersion: string): Promise<unknown> {
    if (!(await isOfficialUpdatesEnabled())) return;
    if (this.macDownloadedInfo?.version === targetVersion) {
      // Rechecking the same release must not replace Squirrel's existing feed.
      this.onUpdateDownloaded?.(this.macDownloadedInfo);
      return;
    }
    updateLifecycleLog.downloadRequested(targetVersion);
    return autoUpdater.downloadUpdate();
  }

  private async prepareMacUpdate(targetVersion: string): Promise<void> {
    const downloaded = this.macDownloadedInfo;
    if (downloaded?.version !== targetVersion) {
      throw new Error(`Squirrel's feed is not serving Paseo ${targetVersion}.`);
    }
    if (this.macNativeReady) return;
    const feedUrl = electronAutoUpdater.getFeedURL();
    const feedOrigin = new URL(feedUrl).origin;

    // Squirrel schedules installation before emitting update-downloaded, so
    // call it only after consent, shutdown and the final settings check.
    // Own the readiness listener so a failed attempt leaves no install callback.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        electronAutoUpdater.removeListener("update-downloaded", onReady);
        electronAutoUpdater.removeListener("update-not-available", onUnavailable);
        electronAutoUpdater.removeListener("error", onError);
      };
      const onReady = (
        _event: Electron.Event,
        _notes: string,
        _name: string,
        _date: Date,
        updateUrl: string,
      ) => {
        if (!URL.canParse(updateUrl) || new URL(updateUrl).origin !== feedOrigin) return;
        cleanup();
        resolve();
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const onUnavailable = () =>
        onError(new Error(`Squirrel did not find Paseo ${targetVersion}.`));
      electronAutoUpdater.on("update-downloaded", onReady);
      electronAutoUpdater.once("update-not-available", onUnavailable);
      electronAutoUpdater.once("error", onError);
      try {
        electronAutoUpdater.checkForUpdates();
      } catch (error) {
        onError(error);
      }
    });
    if (this.macDownloadedInfo !== downloaded || electronAutoUpdater.getFeedURL() !== feedUrl) {
      throw new Error(`Squirrel's feed changed while preparing Paseo ${targetVersion}.`);
    }
    this.macNativeReady = true;
  }

  async quitAndInstall({
    targetVersion,
    isSilent,
    isForceRunAfter,
  }: AppUpdateInstallRequest): Promise<void> {
    const isMac = process.platform === "darwin";
    if (isMac) await this.prepareMacUpdate(targetVersion);
    autoUpdater.autoRunAppAfterInstall = isForceRunAfter;
    updateLifecycleLog.quitAndInstallRequested({
      targetVersion,
      isSilent,
      isForceRunAfter,
    });
    return new Promise((resolve, reject) => {
      const useAppQuit = isMac && !isForceRunAfter;
      const timeout = !isForceRunAfter
        ? setTimeout(
            () => onError(new Error("The updater did not take ownership of the quit.")),
            QUIT_UPDATE_HANDOFF_TIMEOUT_MS,
          )
        : undefined;
      const onHandoff = () => {
        cleanup();
        resolve();
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        app.removeListener("before-quit", onHandoff);
        electronAutoUpdater.removeListener("before-quit-for-update", onHandoff);
        autoUpdater.removeListener("error", onError);
      };
      autoUpdater.once("error", onError);
      if (useAppQuit) app.once("before-quit", onHandoff);
      else electronAutoUpdater.once("before-quit-for-update", onHandoff);
      try {
        macUpdateQuitInProgress = useAppQuit;
        autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
      } catch (error) {
        onError(error);
      } finally {
        macUpdateQuitInProgress = false;
      }
    });
  }
}

const appUpdateService = createAppUpdateService({
  runtime: new ElectronAppUpdateRuntime(),
  isUpdatesEnabled: isOfficialUpdatesEnabled,
  isPackaged: () => app.isPackaged,
  now: () => Date.now(),
  bucket: async () => bucketFromStagingUserId(await getStagingUserId()),
  reportCheckError: (error) => {
    console.error("[auto-updater] Failed to check for updates:", error);
  },
  reportRuntimeError: (error) => {
    console.error("[auto-updater] Updater event failed:", error);
  },
  reportInstallError: (message) => {
    console.error("[auto-updater] Failed to download/install update:", message);
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function hasDownloadedAppUpdate(): boolean {
  return (
    shouldInstallAppUpdateOnQuit({
      platform: process.platform,
      isAppImage: Boolean(process.env.APPIMAGE),
    }) && appUpdateService.hasDownloadedUpdate()
  );
}

export function isMacUpdateQuitInProgress(): boolean {
  return macUpdateQuitInProgress;
}

export async function confirmOfficialUpdateWithoutAgentResume(
  target: AppUpdateTarget,
  cancelLabel: string,
  signal?: AbortSignal,
): Promise<boolean> {
  // Official desktop update manifests do not attest to daemon recovery support.
  if (signal?.aborted) return false;
  const parent = signal && (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]);
  // On macOS a message box without a parent cannot be cancelled by the deadline.
  if (signal && process.platform === "darwin" && !parent) return false;
  const options = {
    type: "warning" as const,
    title: "Paseo Desktop Update",
    message: `Agent recovery is unverified for Paseo ${target.version}.`,
    detail:
      "Paseo will stop the built-in daemon without requesting one-time agent recovery. Agents may need to be resumed manually.",
    buttons: ["Install Update", cancelLabel],
    defaultId: 0,
    cancelId: 1,
    signal,
  };
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
}

export async function checkForAppUpdate({
  currentVersion,
  releaseChannel,
  intent,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
}): Promise<AppUpdateCheckResult> {
  updateLifecycleLog.checkStarted({ currentVersion, releaseChannel, intent });
  const result = await appUpdateService.checkForAppUpdate({
    currentVersion,
    releaseChannel,
    intent,
  });
  updateLifecycleLog.checkCompleted({
    currentVersion,
    targetVersion: result.latestVersion,
    releaseChannel,
    intent,
    hasUpdate: result.hasUpdate,
    readyToInstall: result.readyToInstall,
    errorMessage: result.errorMessage,
  });
  return result;
}

export async function downloadAndInstallUpdate(
  {
    currentVersion,
    releaseChannel,
  }: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
  },
  onBeforeQuit?: BeforeAppUpdateInstall,
): Promise<AppUpdateInstallResult> {
  return appUpdateService.downloadAndInstallUpdate(
    { currentVersion, releaseChannel },
    onBeforeQuit,
  );
}

export async function installAppUpdateOnQuit({
  currentVersion,
  releaseChannel,
  signal,
  onBeforeQuit,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  signal: AbortSignal;
  onBeforeQuit: BeforeAppUpdateInstall;
}): Promise<boolean> {
  if (
    !shouldInstallAppUpdateOnQuit({
      platform: process.platform,
      isAppImage: Boolean(process.env.APPIMAGE),
    })
  ) {
    return false;
  }

  return appUpdateService.installUpdateOnQuit({
    currentVersion,
    releaseChannel,
    signal,
    onBeforeQuit,
  });
}
