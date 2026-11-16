import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  checkDesktopAppUpdate,
  formatVersionWithPrefix,
  installDesktopAppUpdate,
  shouldShowDesktopUpdateSection,
  type DesktopAppUpdateCheckResult,
  type DesktopAppUpdateCheckIntent,
  type DesktopAppUpdateInstallResult,
} from "@/desktop/updates/desktop-updates";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useDesktopIpcErrorReporter } from "@/desktop/hooks/desktop-ipc-error";
import {
  PENDING_RECHECK_MS,
  createDesktopAppUpdater,
  formatStatusText,
  type DesktopAppUpdateStatus,
} from "@/desktop/updates/desktop-app-updater";
import { i18n } from "@/i18n/i18next";
import { formatMessageTimestamp } from "@/utils/time";

export type { DesktopAppUpdateStatus };

export interface UseDesktopAppUpdaterReturn {
  isDesktopApp: boolean;
  updatesEnabled: boolean;
  status: DesktopAppUpdateStatus;
  statusText: string;
  availableUpdate: DesktopAppUpdateCheckResult | null;
  errorMessage: string | null;
  lastCheckedAt: number | null;
  isChecking: boolean;
  isInstalling: boolean;
  checkForUpdates: (options?: {
    intent?: DesktopAppUpdateCheckIntent;
    silent?: boolean;
  }) => Promise<DesktopAppUpdateCheckResult | null>;
  installUpdate: () => Promise<DesktopAppUpdateInstallResult | null>;
}

export function useDesktopAppUpdater(): UseDesktopAppUpdaterReturn {
  const isDesktopApp = shouldShowDesktopUpdateSection();
  const { settings: desktopSettings, isLoading, error } = useDesktopSettings();
  const updatesEnabled = !isLoading && !error && desktopSettings.officialUpdatesEnabled;
  const releaseChannel = desktopSettings.releaseChannel;
  const reportError = useDesktopIpcErrorReporter();

  const updater = useMemo(
    () =>
      createDesktopAppUpdater({
        port: {
          checkDesktopAppUpdate,
          installDesktopAppUpdate,
        },
        now: () => Date.now(),
        reportInstallError: reportError,
      }),
    [reportError],
  );

  const snapshot = useSyncExternalStore(
    updater.subscribe,
    updater.getSnapshot,
    updater.getSnapshot,
  );

  const checkForUpdates = useCallback(
    async (options: { intent?: DesktopAppUpdateCheckIntent; silent?: boolean } = {}) => {
      if (!isDesktopApp || !updatesEnabled) {
        return null;
      }
      return updater.checkForUpdates({
        releaseChannel,
        intent: options.intent ?? "manual",
        silent: options.silent,
      });
    },
    [isDesktopApp, updatesEnabled, releaseChannel, updater],
  );

  const installUpdate = useCallback(async () => {
    if (!isDesktopApp || !updatesEnabled) {
      return null;
    }
    return updater.installUpdate({ releaseChannel });
  }, [isDesktopApp, updatesEnabled, releaseChannel, updater]);

  useEffect(() => {
    if (!isDesktopApp || !updatesEnabled) {
      return;
    }
    void checkForUpdates({ intent: "automatic", silent: true });
  }, [checkForUpdates, isDesktopApp, updatesEnabled]);

  useEffect(() => {
    if (!isDesktopApp || !updatesEnabled || snapshot.status !== "pending") {
      return undefined;
    }

    const intervalId = setInterval(() => {
      void checkForUpdates({ intent: "automatic", silent: true });
    }, PENDING_RECHECK_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [checkForUpdates, isDesktopApp, updatesEnabled, snapshot.status]);

  return {
    isDesktopApp,
    updatesEnabled,
    status: updatesEnabled ? snapshot.status : "idle",
    statusText: updatesEnabled
      ? formatStatusText({
          status: snapshot.status,
          availableUpdate: snapshot.availableUpdate,
          installMessage: snapshot.installMessage,
          lastCheckedAt: snapshot.lastCheckedAt,
          formatVersion: formatVersionWithPrefix,
          formatLastCheckedAt: (timestamp) => formatMessageTimestamp(new Date(timestamp)),
        })
      : i18n.t("settings.about.officialUpdates.disabled"),
    availableUpdate: updatesEnabled ? snapshot.availableUpdate : null,
    errorMessage: updatesEnabled ? snapshot.errorMessage : null,
    lastCheckedAt: snapshot.lastCheckedAt,
    isChecking: snapshot.isChecking,
    isInstalling: snapshot.isInstalling,
    checkForUpdates,
    installUpdate,
  };
}
