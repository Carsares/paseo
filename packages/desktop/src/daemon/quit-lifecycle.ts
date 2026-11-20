import type { DesktopSettingsStore } from "../settings/desktop-settings.js";
import type { AppUpdateTarget, BeforeAppUpdateInstall } from "../features/app-update-service.js";

interface QuitLifecycleSettings {
  daemon: {
    keepRunningAfterQuit: boolean;
  };
}

interface BeforeQuitEvent {
  preventDefault(): void;
}

interface BeforeQuitApp {
  exit(code: number): void;
  quit?(): void;
}

interface ExternalQuitSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

interface QuitLifecycle {
  isQuitting(): boolean;
  handleBeforeQuit(event: BeforeQuitEvent): void;
  handleBeforeQuitForUpdate(): void;
  requestPreserveWorkQuit(): void;
}

export interface StopOnQuitDeps {
  settingsStore: Pick<DesktopSettingsStore, "get">;
  isDesktopManagedDaemonRunning: () => boolean;
  isDesktopManagedDaemonPresent?: () => boolean;
  appUpdate?: AppUpdateTarget;
  stopDaemon: (reason?: "quit" | "app_update" | "quit_preserve_work") => Promise<unknown>;
  showShutdownFeedback: () => void;
  preserveWork?: boolean;
}

export function registerExternalQuitSignals({
  signals,
  quit,
}: {
  signals: ExternalQuitSignalSource;
  quit: () => void;
}): void {
  let quitRequested = false;
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] satisfies NodeJS.Signals[]) {
    signals.on(signal, () => {
      if (quitRequested) return;
      quitRequested = true;
      quit();
    });
  }
}

export function shouldStopDesktopManagedDaemonOnQuit(settings: QuitLifecycleSettings): boolean {
  return !settings.daemon.keepRunningAfterQuit;
}

export async function stopDesktopManagedDaemonOnQuitIfNeeded(
  deps: StopOnQuitDeps,
): Promise<boolean> {
  if (deps.preserveWork === true) {
    if (!(deps.isDesktopManagedDaemonPresent ?? deps.isDesktopManagedDaemonRunning)()) {
      return false;
    }
    deps.showShutdownFeedback();
    await deps.stopDaemon("quit_preserve_work");
    return true;
  }

  const settings = await deps.settingsStore.get();
  if (!shouldStopDesktopManagedDaemonOnQuit(settings)) {
    return false;
  }

  const shouldStopDaemon = deps.appUpdate
    ? (deps.isDesktopManagedDaemonPresent ?? deps.isDesktopManagedDaemonRunning)()
    : deps.isDesktopManagedDaemonRunning();
  if (!shouldStopDaemon) {
    return false;
  }

  deps.showShutdownFeedback();
  await deps.stopDaemon(deps.appUpdate ? "app_update" : "quit");
  return true;
}

function waitForUpdateDeadline(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(false), { once: true });
  });
}

export function createQuitLifecycle({
  app,
  closeTransportSessions,
  stopDesktopManagedDaemonIfNeeded,
  installAppUpdateOnQuit,
  confirmAppUpdate,
  createUpdateDeadlineSignal,
  isManualUpdateHandoffInProgress = () => false,
  onStopError,
  onPreserveWorkStopFailed,
  onUpdateError,
}: {
  app: BeforeQuitApp;
  closeTransportSessions: () => void;
  stopDesktopManagedDaemonIfNeeded: (options?: {
    preserveWork?: boolean;
    appUpdate?: AppUpdateTarget;
  }) => Promise<boolean>;
  installAppUpdateOnQuit: (
    signal: AbortSignal,
    onBeforeQuit: BeforeAppUpdateInstall,
  ) => Promise<boolean>;
  confirmAppUpdate?: (target: AppUpdateTarget, signal: AbortSignal) => Promise<boolean>;
  createUpdateDeadlineSignal: () => AbortSignal;
  isManualUpdateHandoffInProgress?: () => boolean;
  onStopError: (error: unknown) => void;
  onPreserveWorkStopFailed?: (error: unknown) => void;
  onUpdateError: (error: unknown) => void;
}): QuitLifecycle {
  // The first quit waits for daemon shutdown and update revalidation. A validated
  // update re-fires app.quit(); otherwise app.exit(0) bypasses Electron's macOS
  // window-all-closed handler, which would veto that second quit.
  let quitting = false;
  let quittingForUpdate = false;
  let preserveWorkRequested = false;

  function handleBeforeQuit(event: BeforeQuitEvent): void {
    if (!quittingForUpdate && isManualUpdateHandoffInProgress()) {
      event.preventDefault();
      return;
    }
    if (!preserveWorkRequested) closeTransportSessions();
    if (quittingForUpdate) return;
    if (quitting) {
      event.preventDefault();
      return;
    }
    quitting = true;
    event.preventDefault();

    void (async () => {
      if (preserveWorkRequested) {
        try {
          await stopDesktopManagedDaemonIfNeeded({ preserveWork: true });
        } catch (error) {
          quitting = false;
          preserveWorkRequested = false;
          onStopError(error);
          onPreserveWorkStopFailed?.(error);
          return;
        }
        preserveWorkRequested = false;
        closeTransportSessions();
        app.exit(0);
        return;
      }

      let selectedUpdate = false;
      let stoppedForUpdate = false;
      const signal = createUpdateDeadlineSignal();
      const updateInstallation = installAppUpdateOnQuit(signal, async (appUpdate) => {
        if (signal.aborted) return false;
        if (confirmAppUpdate && !(await confirmAppUpdate(appUpdate, signal))) return false;
        if (signal.aborted) return false;
        selectedUpdate = true;
        try {
          stoppedForUpdate = await stopDesktopManagedDaemonIfNeeded({ appUpdate });
        } catch (error) {
          onStopError(error);
          return false;
        }
        return undefined;
      }).catch((error) => {
        onUpdateError(error);
        return false;
      });
      let installingUpdate = await Promise.race([
        updateInstallation,
        waitForUpdateDeadline(signal),
      ]);
      // Once shutdown has started, finish the chosen attempt before exiting.
      if (selectedUpdate) installingUpdate = await updateInstallation;
      if (installingUpdate) return;

      if (!stoppedForUpdate) {
        await stopDesktopManagedDaemonIfNeeded().catch(onStopError);
      }
      app.exit(0);
    })();
  }

  return {
    isQuitting: () => quitting || quittingForUpdate,
    handleBeforeQuit,
    requestPreserveWorkQuit() {
      if (quitting || quittingForUpdate || isManualUpdateHandoffInProgress()) return;
      preserveWorkRequested = true;
      app.quit?.();
    },
    handleBeforeQuitForUpdate() {
      quittingForUpdate = true;
    },
  };
}
