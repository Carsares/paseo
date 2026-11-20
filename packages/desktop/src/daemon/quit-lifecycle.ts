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
  handleBeforeQuitForUpdate(accepted?: boolean): void;
  requestPreserveWorkQuit(): void;
}

export interface StopOnQuitDeps {
  settingsStore: Pick<DesktopSettingsStore, "get">;
  isDesktopManagedDaemonRunning: () => boolean;
  isDesktopManagedDaemonPresent?: () => boolean;
  stopDaemon: (reason?: "quit" | "quit_preserve_work") => Promise<unknown>;
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

  if (!deps.isDesktopManagedDaemonRunning()) {
    return false;
  }

  deps.showShutdownFeedback();
  await deps.stopDaemon("quit");
  return true;
}

export function createQuitLifecycle({
  app,
  closeTransportSessions,
  stopDesktopManagedDaemonIfNeeded,
  prepareDaemonForAppUpdate,
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
  stopDesktopManagedDaemonIfNeeded: (options?: { preserveWork?: boolean }) => Promise<boolean>;
  prepareDaemonForAppUpdate?: BeforeAppUpdateInstall;
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
  let ignoreLateUpdaterQuit = false;
  let preserveWorkRequested = false;

  function handleBeforeQuit(event: BeforeQuitEvent): void {
    if (ignoreLateUpdaterQuit) {
      event.preventDefault();
      return;
    }
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

      let stoppedForUpdate = false;
      const signal = createUpdateDeadlineSignal();
      let onDeadline!: () => void;
      const deadline = new Promise<boolean>((resolve) => {
        onDeadline = () => resolve(false);
        if (signal.aborted) onDeadline();
        else signal.addEventListener("abort", onDeadline, { once: true });
      });
      const updateInstallation = installAppUpdateOnQuit(signal, async (appUpdate) => {
        if (signal.aborted) return false;
        if (confirmAppUpdate && !(await confirmAppUpdate(appUpdate, signal))) return false;
        if (signal.aborted) return false;
        // Validation and consent have their own deadline. The installer uses
        // independent time limits once an update is selected.
        signal.removeEventListener("abort", onDeadline);
        try {
          const shutdown = await prepareDaemonForAppUpdate?.(appUpdate);
          stoppedForUpdate = Boolean(shutdown);
          return shutdown;
        } catch (error) {
          onStopError(error);
          return false;
        }
      }).catch((error) => {
        onUpdateError(error);
        return false;
      });
      const installingUpdate = await Promise.race([updateInstallation, deadline]);
      signal.removeEventListener("abort", onDeadline);
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
    handleBeforeQuitForUpdate(accepted = true) {
      if (!accepted) {
        // BaseUpdater emits its handoff event immediately before app.quit().
        // Ignore this pair after the attempt has failed, without blocking user quits.
        ignoreLateUpdaterQuit = true;
        queueMicrotask(() => {
          ignoreLateUpdaterQuit = false;
        });
        return;
      }
      quittingForUpdate = true;
    },
  };
}
