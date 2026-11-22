import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, autoUpdater as electronAutoUpdater, BrowserWindow, dialog } from "electron";
import { UUID } from "builder-util-runtime";
import log from "electron-log/main";
import { autoUpdater } from "electron-updater";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import {
  AppUpdateHandoffUncertainError,
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
let nativeUpdateHandoffInProgress = false;
let nativeUpdateQuitAccepted = false;

const UPDATE_CHANNEL_NOT_PUBLISHED_CODE = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
const MAC_UPDATE_PREPARATION_TIMEOUT_MS = 30_000;
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
  private macNativeInstallPending = false;
  private macPreparationTimedOut = false;
  private nativeHandoffTimedOut = false;
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
    const feedUrl = electronAutoUpdater.getFeedURL();
    const feedOrigin = new URL(feedUrl).origin;

    // Squirrel schedules installation before emitting update-downloaded, so
    // call it only after consent, shutdown and the final settings check.
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
        // A different feed cannot approve this handoff, but its update can still install on exit.
        this.macNativeInstallPending = true;
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
  }

  private async waitForMacPreparation(preparation: Promise<void>): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        this.macPreparationTimedOut = true;
        reject(new Error("macOS did not finish preparing the update in time."));
      }, MAC_UPDATE_PREPARATION_TIMEOUT_MS);
    });
    try {
      await Promise.race([preparation, deadline]);
    } finally {
      clearTimeout(timeout);
    }
  }

  getInstallBlockReason(): string | undefined {
    // Native events have no attempt identifier. A late event must not
    // acknowledge a second install in this process.
    if (
      this.nativeHandoffTimedOut ||
      (process.platform === "darwin" &&
        (this.macNativeInstallPending || this.macPreparationTimedOut))
    ) {
      return "Restart Paseo before retrying the update.";
    }
    return undefined;
  }

  async quitAndInstall(
    request: AppUpdateInstallRequest,
    beforeHandoff?: () => Promise<void>,
  ): Promise<void> {
    const isMac = process.platform === "darwin";
    await beforeHandoff?.();
    const release = isMac ? await getDesktopSettingsStore().beginOfficialUpdateInstall() : null;
    if (isMac && !release) throw new Error("Official updates are disabled.");
    let macPreparation: Promise<void> | undefined;
    try {
      if (isMac) {
        macPreparation = this.prepareMacUpdate(request.targetVersion);
        await this.waitForMacPreparation(macPreparation);
      }
      if (!isMac && !(await isOfficialUpdatesEnabled())) {
        throw new Error("Official updates are disabled.");
      }
      await this.handoffUpdate(request, isMac);
    } catch (error) {
      if (isMac && (this.macNativeInstallPending || this.macPreparationTimedOut)) {
        const timeoutMessage = this.macPreparationTimedOut
          ? "macOS did not finish preparing the update in time. "
          : "";
        throw new AppUpdateHandoffUncertainError(
          `${timeoutMessage}macOS may install the update on exit. Quit and reopen Paseo before retrying.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (release && macPreparation && this.macPreparationTimedOut) {
        // Electron cannot cancel the native check. Its terminal event can
        // unlock settings, but only the original caller can start a handoff.
        void macPreparation.then(release, release);
      } else {
        release?.();
      }
    }
  }

  private handoffUpdate(request: AppUpdateInstallRequest, isMac: boolean): Promise<void> {
    const { isSilent, isForceRunAfter } = request;
    autoUpdater.autoRunAppAfterInstall = isForceRunAfter;
    updateLifecycleLog.quitAndInstallRequested(request);
    return new Promise((resolve, reject) => {
      const useAppQuit = isMac && !isForceRunAfter;
      let requestReturned = false;
      let acknowledged = false;
      nativeUpdateQuitAccepted = false;
      const timeout = setTimeout(() => {
        this.nativeHandoffTimedOut = true;
        onError(new Error("The updater did not take ownership of the quit."));
      }, QUIT_UPDATE_HANDOFF_TIMEOUT_MS);
      const complete = () => {
        cleanup();
        resolve();
      };
      const onHandoff = () => {
        // BaseUpdater can emit this as soon as it starts the installer, before
        // installation succeeds or the user cancels elevation on Windows.
        // MacUpdater calls app.quit() synchronously on the no-relaunch path.
        // A user quit while the attempt waits cannot acknowledge that call.
        if (useAppQuit && !macUpdateQuitInProgress) return;
        acknowledged = true;
        nativeUpdateQuitAccepted = !useAppQuit;
        if (requestReturned) complete();
      };
      const onError = (error: unknown) => {
        acknowledged = false;
        nativeUpdateQuitAccepted = false;
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        nativeUpdateHandoffInProgress = false;
        app.removeListener("before-quit", onHandoff);
        electronAutoUpdater.removeListener("before-quit-for-update", onHandoff);
        autoUpdater.removeListener("error", onError);
      };
      autoUpdater.once("error", onError);
      if (useAppQuit) app.on("before-quit", onHandoff);
      else electronAutoUpdater.once("before-quit-for-update", onHandoff);
      try {
        macUpdateQuitInProgress = useAppQuit;
        nativeUpdateHandoffInProgress = !useAppQuit;
        autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
        requestReturned = true;
        // Electron can acknowledge the quit before reporting a synchronous error.
        if (acknowledged) complete();
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

export function isNativeUpdateHandoffInProgress(): boolean {
  return nativeUpdateHandoffInProgress;
}

export function hasAcceptedNativeUpdateQuit(): boolean {
  return nativeUpdateQuitAccepted;
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
      "Agents may need to be resumed manually after installing. If installation fails, the current version will try to resume running agents when supported.",
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
