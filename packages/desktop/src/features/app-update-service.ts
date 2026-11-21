import {
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
} from "./app-update-rollout.js";

export interface AppUpdateCheckResult {
  hasUpdate: boolean;
  readyToInstall: boolean;
  currentVersion: string;
  latestVersion: string;
  body: string | null;
  date: string | null;
  errorMessage: string | null;
}

export interface AppUpdateInstallResult {
  /** The native updater accepted the handoff. The next launch determines the installed version. */
  installed: boolean;
  version: string | null;
  message: string;
}

export interface RuntimeUpdateInfo {
  version: string;
  releaseNotes?: unknown;
  releaseDate?: unknown;
  rolloutHours?: unknown;
}

export interface RuntimeUpdateCheckResult {
  isUpdateAvailable: boolean;
  updateInfo: RuntimeUpdateInfo;
}

export interface AppUpdateRuntimeConfiguration {
  releaseChannel: AppReleaseChannel;
  shouldAdmitUpdate(info: RuntimeUpdateInfo): boolean | Promise<boolean>;
  onUpdateAvailable(info: RuntimeUpdateInfo): void;
  onUpdateDownloaded(info: RuntimeUpdateInfo): void;
  onError(error: unknown): void;
}

export interface AppUpdateInstallRequest {
  targetVersion: string;
  isSilent: boolean;
  isForceRunAfter: boolean;
}

export interface AppUpdateRuntime {
  configure(input: AppUpdateRuntimeConfiguration): void;
  checkForUpdates(): Promise<RuntimeUpdateCheckResult | null>;
  downloadUpdate(targetVersion: string): Promise<unknown>;
  getInstallBlockReason?(): string | undefined;
  /** Resolves after the native updater takes ownership of quitting the app. */
  quitAndInstall(
    input: AppUpdateInstallRequest,
    beforeHandoff?: () => Promise<void>,
  ): void | Promise<void>;
}

export interface AppUpdateTarget {
  version: string;
}

export interface AppUpdateShutdown {
  restore(): Promise<void>;
  beforeHandoff(): Promise<void>;
  preserveForNextLaunch?(): Promise<void>;
}

/** The native updater may already install on exit. Keep the daemon stopped. */
export class AppUpdateHandoffUncertainError extends Error {}

export type BeforeAppUpdateInstall = (
  target: AppUpdateTarget,
) => Promise<void | false | AppUpdateShutdown>;

export interface AppUpdateService {
  hasDownloadedUpdate(): boolean;
  checkForAppUpdate(input: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
    intent: AppUpdateCheckIntent;
  }): Promise<AppUpdateCheckResult>;
  downloadAndInstallUpdate(
    input: {
      currentVersion: string;
      releaseChannel: AppReleaseChannel;
    },
    onBeforeQuit?: BeforeAppUpdateInstall,
  ): Promise<AppUpdateInstallResult>;
  installUpdateOnQuit(input: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
    signal: AbortSignal;
    onBeforeQuit?: BeforeAppUpdateInstall;
  }): Promise<boolean>;
}

export interface AppUpdateServiceDeps {
  runtime: AppUpdateRuntime;
  isPackaged(): boolean;
  isUpdatesEnabled(): Promise<boolean>;
  now(): number;
  bucket(): Promise<number>;
  reportCheckError?(error: unknown): void;
  reportRuntimeError?(error: unknown): void;
  reportInstallError?(message: string): void;
}

function buildCheckResult(input: {
  currentVersion: string;
  hasUpdate: boolean;
  readyToInstall: boolean;
  info?: RuntimeUpdateInfo | null;
  errorMessage?: string | null;
}): AppUpdateCheckResult {
  const { currentVersion, hasUpdate, readyToInstall, info, errorMessage = null } = input;

  return {
    hasUpdate,
    readyToInstall,
    currentVersion,
    latestVersion: info?.version ?? currentVersion,
    body: typeof info?.releaseNotes === "string" ? info.releaseNotes : null,
    date: typeof info?.releaseDate === "string" ? info.releaseDate : null,
    errorMessage,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function buildDeferredInstallResult(currentVersion: string): AppUpdateInstallResult {
  return {
    installed: false,
    version: currentVersion,
    message: "Update validation timed out. The update will be installed later.",
  };
}

export function createAppUpdateService(deps: AppUpdateServiceDeps): AppUpdateService {
  let cachedUpdateInfo: RuntimeUpdateInfo | null = null;
  let downloadedUpdateVersion: string | null = null;
  let configuredReleaseChannel: AppReleaseChannel | null = null;
  let preparationError: { version: string; message: string } | null = null;
  let preparingUpdateVersion: string | null = null;
  let checkQueue: Promise<void> = Promise.resolve();

  function disabledCheckResult(currentVersion: string): AppUpdateCheckResult {
    clearUpdateState();
    return buildCheckResult({
      currentVersion,
      hasUpdate: false,
      readyToInstall: false,
      errorMessage: "Official updates are disabled.",
    });
  }

  function isReadyToInstallVersion(version: string): boolean {
    return downloadedUpdateVersion === version;
  }

  function clearUpdateState(): void {
    cachedUpdateInfo = null;
    downloadedUpdateVersion = null;
    preparationError = null;
    preparingUpdateVersion = null;
  }

  function buildPreviouslyAdmittedUpdateResult(
    currentVersion: string,
    checkedInfo: RuntimeUpdateInfo,
  ): AppUpdateCheckResult | null {
    const info = cachedUpdateInfo;
    if (!info || info.version === currentVersion || info.version !== checkedInfo.version) {
      return null;
    }

    return buildCheckResult({
      currentVersion,
      hasUpdate: true,
      readyToInstall: isReadyToInstallVersion(info.version),
      info,
      errorMessage: preparationError?.version === info.version ? preparationError.message : null,
    });
  }

  function configureRuntime(releaseChannel: AppReleaseChannel, intent: AppUpdateCheckIntent): void {
    if (configuredReleaseChannel !== releaseChannel) {
      clearUpdateState();
      configuredReleaseChannel = releaseChannel;
    }

    deps.runtime.configure({
      releaseChannel,
      shouldAdmitUpdate: async (info) => {
        if (!(await deps.isUpdatesEnabled())) return false;
        const parsed = rolloutManifestSchema.parse(info);
        return shouldAdmitAppUpdate({
          channel: releaseChannel,
          intent,
          rolloutHours: parsed.rolloutHours,
          releaseDate: parsed.releaseDate,
          now: deps.now(),
          bucket: await deps.bucket(),
        });
      },
      onUpdateAvailable(info) {
        const alreadyReady = downloadedUpdateVersion === info.version;
        cachedUpdateInfo = info;
        downloadedUpdateVersion = alreadyReady ? info.version : null;
        if (!alreadyReady && preparingUpdateVersion === null) {
          preparingUpdateVersion = info.version;
        }
      },
      onUpdateDownloaded(info) {
        // A superseded download can finish after a newer manifest check. Keep
        // the validated manifest as the install target in that case.
        cachedUpdateInfo ??= info;
        downloadedUpdateVersion = info.version;
        if (preparingUpdateVersion === info.version) {
          preparingUpdateVersion = null;
        }
        if (preparationError?.version === info.version) {
          preparationError = null;
        }
      },
      onError(error) {
        if (preparingUpdateVersion) {
          preparationError = {
            version: preparingUpdateVersion,
            message: getErrorMessage(error),
          };
          preparingUpdateVersion = null;
        }
        deps.reportRuntimeError?.(error);
      },
    });
  }

  function runCheckExclusively<T>(check: () => Promise<T>): Promise<T> {
    const result = checkQueue.then(check, check);
    checkQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function checkForAppUpdateUnlocked({
    currentVersion,
    releaseChannel,
    intent,
  }: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
    intent: AppUpdateCheckIntent;
  }): Promise<AppUpdateCheckResult> {
    if (!deps.isPackaged()) {
      return buildCheckResult({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
      });
    }

    if (!(await deps.isUpdatesEnabled())) return disabledCheckResult(currentVersion);
    configureRuntime(releaseChannel, intent);

    try {
      const result = await deps.runtime.checkForUpdates();
      if (!(await deps.isUpdatesEnabled())) return disabledCheckResult(currentVersion);
      if (!result || !result.updateInfo) {
        clearUpdateState();
        return buildCheckResult({
          currentVersion,
          hasUpdate: false,
          readyToInstall: false,
        });
      }

      if (!result.isUpdateAvailable) {
        const admittedUpdate = buildPreviouslyAdmittedUpdateResult(
          currentVersion,
          result.updateInfo,
        );
        if (admittedUpdate) {
          return admittedUpdate;
        }

        clearUpdateState();
        return buildCheckResult({
          currentVersion,
          hasUpdate: false,
          readyToInstall: false,
        });
      }

      const info = result.updateInfo;
      const latestVersion = info.version;
      const hasUpdate = latestVersion !== currentVersion;

      if (hasUpdate) {
        cachedUpdateInfo = info;
        const errorMessage =
          preparationError?.version === latestVersion ? preparationError.message : null;
        if (!errorMessage) {
          preparationError = null;
        }
        return buildCheckResult({
          currentVersion,
          hasUpdate: true,
          readyToInstall: isReadyToInstallVersion(latestVersion),
          info,
          errorMessage,
        });
      }

      clearUpdateState();
      return buildCheckResult({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
      });
    } catch (error) {
      deps.reportCheckError?.(error);
      return buildCheckResult({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
        errorMessage: getErrorMessage(error),
      });
    }
  }

  function checkForAppUpdate(
    input: Parameters<AppUpdateService["checkForAppUpdate"]>[0],
  ): Promise<AppUpdateCheckResult> {
    return runCheckExclusively(() => checkForAppUpdateUnlocked(input));
  }

  async function downloadAndInstallUpdate(
    {
      currentVersion,
      releaseChannel,
    }: {
      currentVersion: string;
      releaseChannel: AppReleaseChannel;
    },
    onBeforeQuit?: BeforeAppUpdateInstall,
  ): Promise<AppUpdateInstallResult> {
    if (!deps.isPackaged()) {
      return {
        installed: false,
        version: currentVersion,
        message: "Auto-update is not available in development mode.",
      };
    }

    return runCheckExclusively(async () => {
      const check = await checkForAppUpdateUnlocked({
        currentVersion,
        releaseChannel,
        intent: "manual",
      });
      if (!check.hasUpdate) {
        return {
          installed: false,
          version: currentVersion,
          message: check.errorMessage ?? "No update available.",
        };
      }
      return installCheckedUpdate(check, { onBeforeQuit, restart: true });
    });
  }

  async function ensureUpdateDownloaded(
    readyVersion: string,
    signal?: AbortSignal,
  ): Promise<"ready" | "aborted" | "superseded"> {
    while (!isReadyToInstallVersion(readyVersion)) {
      if (!(await deps.isUpdatesEnabled())) return "aborted";
      if (signal?.aborted) return "aborted";
      if (cachedUpdateInfo?.version !== readyVersion) return "superseded";

      const attemptedVersion: string = preparingUpdateVersion ?? readyVersion;
      const previousDownload = downloadedUpdateVersion;
      preparingUpdateVersion ??= readyVersion;
      try {
        await deps.runtime.downloadUpdate(attemptedVersion);
      } catch (error) {
        if (
          attemptedVersion !== readyVersion &&
          cachedUpdateInfo?.version === readyVersion &&
          !signal?.aborted
        ) {
          continue;
        }
        throw error;
      }

      // electron-updater can return an older, already-running download. Its
      // event clears that version, then the next iteration starts the newly
      // validated release instead of treating the stale artifact as ready.
      if (attemptedVersion === readyVersion && !isReadyToInstallVersion(readyVersion)) {
        if (downloadedUpdateVersion !== previousDownload) continue;
        throw new Error(`The updater did not confirm download of Paseo ${readyVersion}.`);
      }
    }

    return signal?.aborted ? "aborted" : "ready";
  }

  async function recoverAfterFailedInstall(
    shutdown: AppUpdateShutdown | undefined,
    installError: string,
    restoreNow: boolean,
  ): Promise<string> {
    if (!shutdown) return installError;
    try {
      if (restoreNow) await shutdown.restore();
      else await shutdown.preserveForNextLaunch?.();
    } catch (error) {
      const action = restoreNow
        ? "restart the built-in daemon"
        : "save agent recovery for next launch";
      const message = `Could not ${action}: ${getErrorMessage(error)}`;
      deps.reportInstallError?.(message);
      return `${installError} ${message}`;
    }
    return installError;
  }

  async function installCheckedUpdate(
    check: AppUpdateCheckResult,
    {
      onBeforeQuit,
      signal,
      restart,
    }: {
      onBeforeQuit?: BeforeAppUpdateInstall;
      signal?: AbortSignal;
      restart: boolean;
    },
  ): Promise<AppUpdateInstallResult> {
    const targetVersion = check.latestVersion;
    const notInstalled = (message: string): AppUpdateInstallResult => ({
      installed: false,
      version: check.currentVersion,
      message,
    });
    let shutdown: AppUpdateShutdown | undefined;
    let installError: string | null = null;
    let handoffUncertain = false;
    try {
      const blocked = deps.runtime.getInstallBlockReason?.();
      if (blocked) return notInstalled(blocked);
      const preparation = await ensureUpdateDownloaded(targetVersion, signal);
      if (preparation === "superseded") {
        return notInstalled("A newer update was found and will be installed later.");
      }
      if (!(await deps.isUpdatesEnabled())) {
        return notInstalled("Official updates are disabled.");
      }
      if (preparation === "aborted" || signal?.aborted) {
        return buildDeferredInstallResult(check.currentVersion);
      }
      if (!isReadyToInstallVersion(targetVersion)) {
        return notInstalled("The validated download is no longer ready.");
      }
      const beforeQuit = await onBeforeQuit?.({ version: targetVersion });
      if (beforeQuit === false) return notInstalled("The update was cancelled.");
      shutdown = beforeQuit || undefined;
      if (!(await deps.isUpdatesEnabled())) {
        installError = "Official updates are disabled.";
      } else if (!isReadyToInstallVersion(targetVersion)) {
        installError = "The validated download is no longer ready.";
      } else {
        await deps.runtime.quitAndInstall(
          { targetVersion, isSilent: !restart, isForceRunAfter: restart },
          beforeQuit ? () => beforeQuit.beforeHandoff() : undefined,
        );
        return {
          installed: true,
          version: targetVersion,
          message: "Update downloaded. The app will restart shortly.",
        };
      }
    } catch (error) {
      handoffUncertain = error instanceof AppUpdateHandoffUncertainError;
      installError = handoffUncertain
        ? getErrorMessage(error)
        : `Update failed: ${getErrorMessage(error)}`;
      deps.reportInstallError?.(installError);
    }

    return notInstalled(
      await recoverAfterFailedInstall(shutdown, installError, restart && !handoffUncertain),
    );
  }

  function hasDownloadedUpdate(): boolean {
    return deps.isPackaged() && downloadedUpdateVersion !== null;
  }

  async function installUpdateOnQuit({
    currentVersion,
    releaseChannel,
    signal,
    onBeforeQuit,
  }: Parameters<AppUpdateService["installUpdateOnQuit"]>[0]): Promise<boolean> {
    if (!hasDownloadedUpdate() || deps.runtime.getInstallBlockReason?.()) return false;
    return runCheckExclusively(async () => {
      if (signal.aborted) return false;
      const check = await checkForAppUpdateUnlocked({
        currentVersion,
        releaseChannel,
        intent: "automatic",
      });
      if (signal.aborted || !check.hasUpdate) return false;
      const result = await installCheckedUpdate(check, { onBeforeQuit, signal, restart: false });
      return result.installed;
    });
  }

  return {
    hasDownloadedUpdate,
    checkForAppUpdate,
    downloadAndInstallUpdate,
    installUpdateOnQuit,
  };
}
