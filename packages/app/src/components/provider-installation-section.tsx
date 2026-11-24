import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  ProviderInstallation,
  ProviderInstallationUpdate,
  ProviderInstallationUpdateCheck,
} from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type Maintenance = NonNullable<ProviderInstallation["maintenance"]>;
const maintenanceLabel = {
  automatic: "settings.providers.installation.maintenanceAutomatic",
  external: "settings.providers.installation.maintenanceExternal",
  manual: "settings.providers.installation.maintenanceManual",
} as const satisfies Record<Maintenance["kind"], string>;

export type ProviderInstallationState =
  | { status: "unsupported" }
  | { status: "loading" }
  | { status: "ready"; installation: ProviderInstallation | null }
  | { status: "error"; message: string };

/**
 * What the provider's update check knows. `hidden` until the provider is installed. A null
 * `updateCheck` means the provider cannot check; the check only informs, and never gates Update.
 */
export type ProviderUpdatesState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "ready"; updateCheck: ProviderInstallationUpdateCheck | null }
  | { status: "error"; message: string };

const hiddenUpdates: ProviderUpdatesState = { status: "hidden" };

/** Running the provider's own update. Absent when the host cannot report updates. */
export interface ProviderUpdateAction {
  /** The provider's latest update since the host started, or null. */
  current: ProviderInstallationUpdate | null;
  /** The request to start an update is in flight. */
  starting: boolean;
  /** Why the host did not start the update. */
  startError: string | null;
  start(): void;
}

export function ProviderInstallationSection({
  state,
  updates,
  action,
}: {
  state: ProviderInstallationState;
  updates: ProviderUpdatesState;
  action?: ProviderUpdateAction;
}) {
  const { t } = useTranslation();
  if (state.status === "unsupported") return null;
  const installation = state.status === "ready" ? state.installation : null;
  const updateUrl = installation?.updateUrl;
  const updating = Boolean(action && isUpdating(action));
  const updateAction = offersUpdater(installation, updating) ? action : undefined;
  const showRunningStatus = !updateAction;
  const run = action ? readUpdateRun(action, showRunningStatus) : null;
  const showUpdates = updating || hasUpdateDetails(installation);
  if (state.status === "ready" && !showUpdates && !run && !hasInstallationDetails(installation)) {
    return null;
  }

  return (
    <View style={settingsStyles.section} testID="provider-installation">
      <View style={settingsStyles.sectionHeader}>
        <Text style={settingsStyles.sectionHeaderTitle}>
          {t("settings.providers.installation.title")}
        </Text>
      </View>
      <View style={settingsStyles.card}>
        <InstallationRow state={state} />
        {showUpdates ? (
          <UpdatesRow
            updates={readShownUpdateCheck(updates, run)}
            maintenance={installation?.maintenance}
            updateUrl={updateUrl}
            action={updateAction}
          />
        ) : null}
        {run ? (
          <UpdateRunRow
            run={run}
            showRunningStatus={showRunningStatus}
            updateUrl={showUpdates && !updateAction ? undefined : updateUrl}
          />
        ) : null}
      </View>
    </View>
  );
}

function hasInstallationDetails(installation: ProviderInstallation | null): boolean {
  return Boolean(installation?.inspection || installation?.installUrl);
}

function hasUpdateDetails(installation: ProviderInstallation | null): boolean {
  const status = installation?.inspection?.status;
  return (
    status === "installed" || (status !== "not_installed" && Boolean(installation?.maintenance))
  );
}

function offersUpdater(installation: ProviderInstallation | null, updating: boolean): boolean {
  const kind = installation?.maintenance?.kind;
  if (kind === "external" || kind === "manual") return false;
  // The binary may be between versions during an update. Keep the progress visible.
  return (
    updating || Boolean(installation?.inspection?.status === "installed" && installation.canUpdate)
  );
}

function readShownUpdateCheck(
  updates: ProviderUpdatesState,
  run: UpdateRun | null,
): ProviderUpdatesState {
  if (updates.status !== "ready" || updates.updateCheck?.status !== "current") return updates;
  const operation = run?.status === "succeeded" ? run.update.operation : undefined;
  // The completed operation already says the CLI was current.
  return operation?.status === "succeeded" && operation.outcome === "already_current"
    ? hiddenUpdates
    : updates;
}

function InstallInstructionsLink({ installUrl }: { installUrl: string }) {
  const { t } = useTranslation();
  return (
    <ExternalLink
      href={installUrl}
      label={t("settings.providers.installation.installInstructions")}
      testID="provider-installation-install-instructions"
    />
  );
}

function InstallationRow({ state }: { state: ProviderInstallationState }) {
  const { t } = useTranslation();
  const installation = state.status === "ready" ? state.installation : null;
  const installUrl = installation?.installUrl;
  const handleInstall = useCallback(() => {
    if (installUrl) void openExternalUrl(installUrl);
  }, [installUrl]);

  if (state.status === "loading") {
    return (
      <View style={settingsStyles.row}>
        <Text style={settingsStyles.rowTitle}>{t("settings.providers.installation.version")}</Text>
        <View style={styles.trailing}>
          <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          <Text style={styles.value}>{t("settings.providers.installation.checking")}</Text>
        </View>
      </View>
    );
  }
  const inspection = installation?.inspection;
  if (inspection?.status === "not_installed") {
    return (
      <View style={settingsStyles.row}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.providers.installation.notInstalled")}
        </Text>
        {installUrl ? (
          <Button variant="outline" onPress={handleInstall}>
            {t("settings.providers.installation.install")}
          </Button>
        ) : null}
      </View>
    );
  }
  if (inspection?.status === "installed") {
    return (
      <View style={settingsStyles.row}>
        <Text style={settingsStyles.rowTitle}>{t("settings.providers.installation.version")}</Text>
        {inspection.version ? (
          <Text
            style={styles.version}
            numberOfLines={1}
            selectable
            dataSet={CODE_SURFACE_DATASET}
            testID="provider-installation-version"
          >
            {inspection.version}
          </Text>
        ) : (
          <Text style={styles.value}>{t("settings.providers.installation.installed")}</Text>
        )}
      </View>
    );
  }
  // The installed state is unknown: the check failed, or the provider only links to a guide.
  let message: string | null = null;
  if (state.status === "error") message = state.message;
  else if (inspection?.status === "error") message = inspection.message;
  if (!message) {
    return installUrl ? (
      <View style={settingsStyles.row}>
        <InstallInstructionsLink installUrl={installUrl} />
      </View>
    ) : null;
  }
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.providers.installation.failed")}</Text>
        <Text style={settingsStyles.rowHint}>{message}</Text>
        {installUrl ? (
          <View style={styles.link}>
            <InstallInstructionsLink installUrl={installUrl} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The update the provider offers, with what its check knows beside it. Update, or the update
 * instructions, stay in place whatever the check says: an answer can be an hour old, and the
 * provider's own updater reports when there is nothing newer.
 */
function UpdatesRow({
  updates,
  maintenance,
  updateUrl,
  action,
}: {
  updates: ProviderUpdatesState;
  maintenance: Maintenance | undefined;
  updateUrl: string | undefined;
  /** Present when the provider runs its own update. */
  action: ProviderUpdateAction | undefined;
}) {
  const { t } = useTranslation();
  const updateCheck = updates.status === "ready" ? updates.updateCheck : null;
  const offersUpdate = Boolean(action || updateUrl);
  // With nothing to offer, the row waits until the check has something to say.
  if (!maintenance && !offersUpdate && !updateCheck && updates.status !== "error") return null;

  let checkMessage: string | undefined;
  if (updates.status === "error") checkMessage = updates.message;
  else if (updateCheck && "message" in updateCheck) checkMessage = updateCheck.message;

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID="provider-updates">
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {updateCheck?.status === "available"
            ? t("settings.providers.installation.updateAvailable")
            : t("settings.providers.installation.updates")}
        </Text>
        <UpdateCheckSummary updates={updates} />
        {maintenance ? (
          <MaintenanceSummary
            maintenance={maintenance}
            hasGuide={Boolean(updateUrl)}
            checkMessage={checkMessage}
          />
        ) : null}
      </View>
      <UpdateButton action={action} updateUrl={updateUrl} />
    </View>
  );
}

function MaintenanceSummary({
  maintenance,
  hasGuide,
  checkMessage,
}: {
  maintenance: Maintenance;
  hasGuide: boolean;
  checkMessage: string | undefined;
}) {
  const { t } = useTranslation();
  const label = t(maintenanceLabel[maintenance.kind]);
  let guidance = maintenance.message;
  if (!guidance && !hasGuide) {
    if (maintenance.kind === "external") {
      guidance = t("settings.providers.installation.maintenanceExternalHint");
    } else if (maintenance.kind === "manual") {
      guidance = t("settings.providers.installation.maintenanceManualHint");
    }
  }
  return (
    <>
      <Text style={settingsStyles.rowHint}>{label}</Text>
      {guidance && guidance !== label && guidance !== checkMessage ? (
        <Text style={settingsStyles.rowHint} selectable>
          {guidance}
        </Text>
      ) : null}
    </>
  );
}

function UpdateCheckSummary({ updates }: { updates: ProviderUpdatesState }) {
  const { t } = useTranslation();
  if (updates.status === "loading") {
    return (
      <View style={styles.trailing}>
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        <Text style={settingsStyles.rowHint}>{t("settings.providers.installation.checking")}</Text>
      </View>
    );
  }
  if (updates.status === "hidden") return null;
  const updateCheck = updates.status === "ready" ? updates.updateCheck : null;
  if (updates.status === "ready" && !updateCheck) return null;
  if (updateCheck?.status === "current") {
    return (
      <Text style={settingsStyles.rowHint} testID="provider-updates-current">
        {t("settings.providers.installation.upToDate")}
      </Text>
    );
  }
  if (updateCheck?.status === "available") {
    // Versions are opaque; drop repeats so each one keys its own line.
    const versions = [...new Set(updateCheck.versions ?? [])];
    return (
      <>
        {versions.map((version) => (
          <Text
            key={version}
            style={styles.availableVersion}
            selectable
            dataSet={CODE_SURFACE_DATASET}
            testID="provider-updates-version"
          >
            {version}
          </Text>
        ))}
        {updateCheck.message ? (
          <Text style={settingsStyles.rowHint}>{updateCheck.message}</Text>
        ) : null}
      </>
    );
  }
  // A check that threw, timed out or could not tell is never shown as up to date.
  const message = updates.status === "error" ? updates.message : updateCheck?.message;
  return (
    <>
      <Text style={settingsStyles.rowHint} testID="provider-updates-unchecked">
        {t("settings.providers.installation.updatesFailed")}
      </Text>
      {message ? <Text style={settingsStyles.rowHint}>{message}</Text> : null}
    </>
  );
}

function isUpdating(action: ProviderUpdateAction): boolean {
  return action.starting || action.current?.operation.status === "running";
}

/**
 * Update runs the provider's updater; without one, the provider's update guide opens. The button
 * carries the update's progress from the tap until it settles.
 */
function UpdateButton({
  action,
  updateUrl,
}: {
  action: ProviderUpdateAction | undefined;
  updateUrl: string | undefined;
}) {
  const { t } = useTranslation();
  const handleOpenInstructions = useCallback(() => {
    if (updateUrl) void openExternalUrl(updateUrl);
  }, [updateUrl]);
  if (action)
    return (
      <Button
        variant="outline"
        onPress={action.start}
        loading={isUpdating(action)}
        testID="provider-update-start"
      >
        {isUpdating(action)
          ? t("settings.providers.installation.updating")
          : t("settings.providers.installation.update")}
      </Button>
    );
  if (!updateUrl) return null;
  return (
    <Button variant="outline" onPress={handleOpenInstructions}>
      {t("settings.providers.installation.updateInstructions")}
    </Button>
  );
}

type UpdateRun =
  | { status: "running"; update: ProviderInstallationUpdate }
  | { status: "succeeded" | "failed"; update: ProviderInstallationUpdate }
  | { status: "refused"; message: string };

/**
 * What the update's row shows, or null for nothing. While the update starts or runs, Update shows
 * its progress and the row holds only the output so far. A new start clears the previous result.
 */
function readUpdateRun(action: ProviderUpdateAction, showRunningStatus: boolean): UpdateRun | null {
  const update = action.current;
  if (isUpdating(action)) {
    return update?.operation.status === "running" && (showRunningStatus || update.output.length > 0)
      ? { status: "running", update }
      : null;
  }
  if (action.startError) return { status: "refused", message: action.startError };
  if (!update || update.operation.status === "running") return null;
  return { status: update.operation.status, update };
}

function readUpdateResult(run: UpdateRun, showRunningStatus: boolean) {
  if (run.status === "running") {
    return {
      label: showRunningStatus ? ("settings.providers.installation.updating" as const) : null,
      showGuide: false,
    };
  }
  if (run.status === "refused") {
    return {
      label: "settings.providers.installation.updateFailed",
      message: run.message,
      showGuide: true,
    } as const;
  }
  const operation = run.update.operation;
  if (operation.status === "failed") {
    return {
      label: "settings.providers.installation.updateFailed",
      message: operation.message,
      showGuide: true,
    } as const;
  }
  if (operation.status !== "succeeded") return { label: null, showGuide: false };
  const label = {
    updated: "settings.providers.installation.updated",
    already_current: "settings.providers.installation.alreadyCurrent",
    unverified: "settings.providers.installation.updateUnverified",
  } as const;
  return {
    label: label[operation.outcome ?? "updated"],
    message: operation.message,
    showGuide: operation.outcome === "unverified",
  };
}

function UpdateRunRow({
  run,
  showRunningStatus,
  updateUrl,
}: {
  run: UpdateRun;
  showRunningStatus: boolean;
  updateUrl: string | undefined;
}) {
  const { t } = useTranslation();
  const scroll = useRef<ScrollView>(null);
  const followOutput = useCallback(() => scroll.current?.scrollToEnd({ animated: false }), []);
  const update = run.status === "refused" ? null : run.update;
  const output = update?.output.map((entry) => entry.text).join("") ?? "";
  const { label, message, showGuide } = readUpdateResult(run, showRunningStatus);
  const status = label ? t(label) : null;

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID="provider-update-run">
      <View style={settingsStyles.rowContent}>
        {status ? (
          <Text style={settingsStyles.rowTitle} testID="provider-update-status">
            {status}
          </Text>
        ) : null}
        {message && message.trim() !== status ? (
          <Text style={settingsStyles.rowHint} selectable testID="provider-update-message">
            {message}
          </Text>
        ) : null}
        {output ? (
          <ScrollView
            ref={scroll}
            style={
              run.status === "running" ? styles.output : [styles.output, styles.outputAfterResult]
            }
            contentContainerStyle={styles.outputContent}
            onContentSizeChange={followOutput}
            // Android scrolls a ScrollView nested in the provider sheet only with this flag.
            nestedScrollEnabled
          >
            {update?.truncated ? (
              <Text style={styles.outputNote}>
                {t("settings.providers.installation.outputTruncated")}
              </Text>
            ) : null}
            <Text
              style={styles.outputText}
              selectable
              dataSet={CODE_SURFACE_DATASET}
              testID="provider-update-output"
            >
              {output}
            </Text>
          </ScrollView>
        ) : null}
        {showGuide && updateUrl ? (
          <View style={styles.link}>
            <ExternalLink
              href={updateUrl}
              label={t("settings.providers.installation.updateInstructions")}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  output: {
    maxHeight: 240,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
  },
  outputAfterResult: {
    marginTop: theme.spacing[2],
  },
  outputContent: {
    padding: theme.spacing[3],
  },
  outputText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  outputNote: {
    marginBottom: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  value: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  version: {
    flexShrink: 1,
    marginLeft: theme.spacing[3],
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
  },
  availableVersion: {
    marginTop: theme.spacing[1],
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
  },
  link: {
    flexDirection: "row",
    marginTop: theme.spacing[1],
  },
}));
