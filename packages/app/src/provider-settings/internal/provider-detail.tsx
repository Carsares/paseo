import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { ProviderInstallationSection } from "@/components/provider-installation-section";
import { useProviderInstallation } from "@/components/provider-installation";
import {
  SettingsCard,
  SettingsDetailRow,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-api-context";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import {
  readAcpProviderInstallGuide,
  type ConfiguredCatalogPinStatus,
} from "@/hooks/use-acp-provider-catalog";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openExternalUrl } from "@/utils/open-external-url";
import { CustomProviderCliFormSheet } from "./custom-provider-cli-form";
import {
  readCatalogPinUpdateTarget,
  readDetailPresence,
  readDetailSections,
  readShownInstallation,
  type DetailPresence,
} from "./detail-sections";
import { DiagnosticSheet } from "./diagnostic-sheet";
import {
  resolveCustomProviderEditTarget,
  useProviderConfigActions,
  useSupportsCustomProviderCli,
  type CustomProviderEditTarget,
  type ProviderEntry,
} from "./provider-config";
import { ProviderModels } from "./provider-models";
import { ProviderNotice } from "./provider-notice";
import { ProviderRefreshButton, useCheckedLabel, type ProviderRefresh } from "./provider-refresh";
import type { ProviderSheetFrame } from "./sheet-frame";

export interface ProviderDetailState {
  provider: string;
  /** The provider's name, kept while this page removes it. */
  label: string;
  presence: DetailPresence;
  /** Config owns the provider, so Remove can delete it. */
  canRemove: (entry: ProviderEntry) => boolean;
  /** This page's Remove is running, or has succeeded and the page is closing. */
  removing: boolean;
  remove: () => void;
}

/**
 * What a provider's detail shows and its Remove, shared by the frame's title and the body. A
 * provider this page removes leaves the host's list before the removal answers; both keep showing
 * it until the frame closes.
 */
export function useProviderDetail({
  serverId,
  provider,
  onRemoved,
}: {
  serverId: string;
  provider: string;
  /** The provider was removed; leave its detail. */
  onRemoved: () => void;
}): ProviderDetailState {
  const { entries, error } = useProvidersSnapshot(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const { canRemove, remove, removing } = useProviderConfigActions(serverId);
  const presence = readDetailPresence({ provider, connected, entries, error, removing });
  const shown = presence.kind === "found" ? presence.entry : null;
  const label = shown?.label ?? provider;
  const handleRemove = useCallback(() => {
    if (!shown) return;
    void remove(shown, label).then((removed) => {
      if (removed) onRemoved();
      return removed;
    });
  }, [label, onRemoved, remove, shown]);
  return {
    provider,
    label,
    presence,
    canRemove,
    removing: removing?.provider === provider,
    remove: handleRemove,
  };
}

/**
 * Everything about one provider, top to bottom: what is wrong, whether it runs, its installation,
 * its models, then the rare actions. The page and the sheet frame the same body.
 *
 * Refresh sits with the model list, which is what it is most often pressed for. A provider that
 * lists no models of its own keeps it under Troubleshooting.
 */
export function ProviderDetail({
  serverId,
  detail,
  sheetFrame,
}: {
  serverId: string;
  detail: ProviderDetailState;
  sheetFrame?: ProviderSheetFrame;
}) {
  const { provider, presence, label } = detail;
  const { refresh, isRefreshing } = useProvidersSnapshot(serverId);
  const { config } = useDaemonConfig(serverId);
  const supportsCustomCli = useSupportsCustomProviderCli(serverId);
  // COMPAT(providerCatalogPinUpdates): added in v0.17.0, remove gate after 2027-05-25.
  const supportsCatalogPinUpdates = useHostFeature(serverId, "providerCatalogPinUpdates");
  const installation = useProviderInstallation({ serverId, provider, visible: true });
  const refreshInstallationRef = useRef(installation.refresh);
  const refreshGenerationRef = useRef(0);
  useEffect(() => {
    refreshInstallationRef.current = installation.refresh;
  }, [installation.refresh]);
  useEffect(() => {
    return () => {
      refreshGenerationRef.current += 1;
    };
  }, [serverId, provider]);
  const handleRefresh = useCallback(() => {
    const generation = ++refreshGenerationRef.current;
    const run = async () => {
      try {
        await refresh([provider]);
      } catch {
        // Snapshot refresh failures stay owned by the snapshot query; still refresh installation.
      }
      if (refreshGenerationRef.current !== generation) return;
      refreshInstallationRef.current();
    };
    void run();
  }, [provider, refresh]);
  if (presence.kind !== "found") return <AbsentProvider presence={presence} />;

  const entry = presence.entry;
  const customCliTarget = supportsCustomCli
    ? resolveCustomProviderEditTarget({ entry, config })
    : null;
  const catalogPinTarget = readCatalogPinUpdateTarget({
    entry,
    config,
    supportsCatalogPinUpdates,
  });
  const shownInstallation = readShownInstallation({
    entry,
    installation: installation.state,
    installGuide: readAcpProviderInstallGuide(provider),
  });
  const sections = readDetailSections(entry, shownInstallation);
  const listsModels = sections.models === "all";
  const providerRefresh: ProviderRefresh = {
    checkedAt: entry.fetchedAt,
    // The probe running again is a refresh too, whoever asked for it.
    busy: isRefreshing || installation.refreshing || entry.status === "loading",
    run: handleRefresh,
  };

  return (
    <View testID="provider-detail">
      {sections.error !== null ? <ProviderErrorAlert label={label} error={sections.error} /> : null}
      <EnabledCard serverId={serverId} entry={entry} />
      <ProviderInstallationSection
        state={shownInstallation}
        updates={installation.updates}
        action={installation.action}
      />
      {catalogPinTarget ? (
        <CatalogPinUpdateSection
          key={JSON.stringify([
            serverId,
            catalogPinTarget.provider,
            catalogPinTarget.currentVersion,
            catalogPinTarget.targetVersion,
          ])}
          serverId={serverId}
          label={label}
          target={catalogPinTarget}
        />
      ) : null}
      {customCliTarget ? (
        <CustomCliSection
          key={`${serverId}:${customCliTarget.initialProvider.providerId}`}
          serverId={serverId}
          target={customCliTarget}
          sheetFrame={sheetFrame}
        />
      ) : null}
      {sections.models ? (
        <ProviderModels
          serverId={serverId}
          entry={entry}
          refresh={listsModels ? providerRefresh : null}
        />
      ) : null}
      <Troubleshooting
        serverId={serverId}
        entry={entry}
        refresh={listsModels ? null : providerRefresh}
      />
      {/* Config no longer owns a provider whose removal has succeeded. */}
      {detail.removing || detail.canRemove(entry) ? (
        <DangerZone removing={detail.removing} onRemove={detail.remove} />
      ) : null}
    </View>
  );
}

function AbsentProvider({ presence }: { presence: Exclude<DetailPresence, { kind: "found" }> }) {
  const { t } = useTranslation();
  const messages = {
    loading: t("settings.providers.loading"),
    missing: t("settings.providers.detail.notOnHost"),
    offline: t("settings.providers.unavailable"),
  };
  const message = presence.kind === "failed" ? presence.message : messages[presence.kind];
  return <ProviderNotice message={message} testID={`provider-detail-${presence.kind}`} />;
}

function ProviderErrorAlert({ label, error }: { label: string; error: string }) {
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.section}>
      <Alert
        variant="error"
        title={t("settings.providers.detail.unavailableTitle", { name: label })}
        description={error || t("settings.providers.diagnostic.unknownError")}
        testID="provider-error"
      />
    </View>
  );
}

function EnabledCard({ serverId, entry }: { serverId: string; entry: ProviderEntry }) {
  const { t } = useTranslation();
  const { setEnabled, togglingProviderId } = useProviderConfigActions(serverId);
  const handleChange = useCallback(
    (enabled: boolean) => setEnabled(entry.provider, enabled),
    [entry.provider, setEnabled],
  );
  return (
    <View style={settingsStyles.section}>
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.providers.detail.enabled")}
          value={entry.enabled}
          onValueChange={handleChange}
          disabled={togglingProviderId === entry.provider}
        />
      </SettingsCard>
    </View>
  );
}

function Troubleshooting({
  serverId,
  entry,
  refresh,
}: {
  serverId: string;
  entry: ProviderEntry;
  /** Null when the model list carries Refresh. */
  refresh: ProviderRefresh | null;
}) {
  const { t } = useTranslation();
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const openDiagnostic = useCallback(() => setDiagnosticOpen(true), []);
  const closeDiagnostic = useCallback(() => setDiagnosticOpen(false), []);
  const docsUrl = entry.docsUrl;
  const openDocs = useCallback(() => {
    if (docsUrl) void openExternalUrl(docsUrl);
  }, [docsUrl]);

  return (
    <SettingsSection title={t("settings.providers.detail.troubleshooting")}>
      <SettingsCard>
        {refresh ? <ProviderStatusRow refresh={refresh} /> : null}
        <SettingsDetailRow
          label={t("settings.providers.detail.diagnosticReport")}
          onPress={openDiagnostic}
          testID="provider-diagnostic-report"
        />
        {docsUrl ? (
          <SettingsDetailRow
            label={t("settings.providers.detail.docs")}
            onPress={openDocs}
            external
            testID="provider-docs"
          />
        ) : null}
      </SettingsCard>
      <DiagnosticSheet
        serverId={serverId}
        provider={entry.provider}
        visible={diagnosticOpen}
        onClose={closeDiagnostic}
      />
    </SettingsSection>
  );
}

function CatalogPinUpdateSection({
  serverId,
  label,
  target,
}: {
  serverId: string;
  label: string;
  target: ConfiguredCatalogPinStatus;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const [updating, setUpdating] = useState(false);
  const updatingRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      updatingRef.current = false;
    };
  }, []);

  const handleUpdate = useCallback(async () => {
    if (updatingRef.current || !client) return;
    const generation = generationRef.current;
    updatingRef.current = true;
    try {
      const confirmed = await confirmDialog({
        title: t("settings.providers.catalogPin.confirmTitle", { name: label }),
        message: t("settings.providers.catalogPin.confirmMessage", {
          current: target.currentVersion,
          target: target.targetVersion,
        }),
        confirmLabel: t("settings.providers.catalogPin.confirmAction"),
      });
      if (!confirmed || generationRef.current !== generation) return;

      setUpdating(true);
      const response = await client.updateProviderCatalogPin({
        provider: target.provider,
        expectedVersion: target.currentVersion,
        version: target.targetVersion,
      });
      if (generationRef.current !== generation) return;

      if (response.status === "updated") {
        // Refresh saved config only; never launch or implicitly download the CLI.
        void queryClient.invalidateQueries({ queryKey: daemonConfigQueryKey(serverId) });
        toast.show(
          t("settings.providers.catalogPin.updatedToast", { version: target.targetVersion }),
          { variant: "success" },
        );
      } else if (response.status === "conflict") {
        void queryClient.invalidateQueries({ queryKey: daemonConfigQueryKey(serverId) });
        toast.error(t("settings.providers.catalogPin.conflictError"));
      } else if (response.status === "unsupported") {
        toast.error(t("settings.providers.catalogPin.unsupportedError"));
      } else {
        toast.error(t("settings.providers.catalogPin.failedError"));
      }
    } catch (error) {
      if (generationRef.current !== generation) return;
      toast.error(
        error instanceof Error ? error.message : t("settings.providers.catalogPin.failedError"),
      );
    } finally {
      if (generationRef.current === generation) {
        updatingRef.current = false;
        setUpdating(false);
      }
    }
  }, [client, label, queryClient, serverId, t, target, toast]);

  return (
    <SettingsSection title={t("settings.providers.catalogPin.sectionTitle")}>
      <SettingsCard>
        <SettingsRow
          label={t("settings.providers.catalogPin.rowTitle")}
          hint={t("settings.providers.catalogPin.rowHint", {
            current: target.currentVersion,
            target: target.targetVersion,
          })}
        >
          <Button
            variant="outline"
            onPress={handleUpdate}
            loading={updating}
            testID="provider-catalog-pin-update"
          >
            {updating
              ? t("settings.providers.catalogPin.updatingAction")
              : t("settings.providers.catalogPin.updateAction")}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function CustomCliSection({
  serverId,
  target,
  sheetFrame,
}: {
  serverId: string;
  target: CustomProviderEditTarget;
  sheetFrame?: ProviderSheetFrame;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const openEdit = useCallback(() => setEditing(true), []);
  const closeEdit = useCallback(() => setEditing(false), []);
  const configuredCommand = target.initialProvider.command?.join(" ");
  const isBuiltin = target.targetKind === "builtin";

  return (
    <SettingsSection title={t("settings.providers.customCli.sectionTitle")}>
      <SettingsCard>
        <SettingsDetailRow
          label={
            isBuiltin
              ? t("settings.providers.customCli.overrideAction")
              : t("settings.providers.customCli.editAction")
          }
          hint={
            configuredCommand ||
            (isBuiltin
              ? t("settings.providers.customCli.overrideHint")
              : t("settings.providers.customCli.editHint"))
          }
          onPress={openEdit}
          testID="provider-edit-custom-cli"
        />
      </SettingsCard>
      <CustomProviderCliFormSheet
        mode="edit"
        target={target}
        serverId={serverId}
        visible={editing}
        onClose={closeEdit}
        frame={sheetFrame}
      />
    </SettingsSection>
  );
}

function ProviderStatusRow({ refresh }: { refresh: ProviderRefresh }) {
  const { t } = useTranslation();
  const checked = useCheckedLabel(refresh);
  return (
    <SettingsRow label={t("settings.providers.detail.status")} hint={checked}>
      <ProviderRefreshButton refresh={refresh} form="labelled" />
    </SettingsRow>
  );
}

function DangerZone({ removing, onRemove }: { removing: boolean; onRemove: () => void }) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("settings.providers.detail.dangerZone")}>
      <SettingsCard>
        <SettingsRow
          label={t("settings.providers.actions.remove")}
          hint={t("settings.providers.detail.removeHint")}
        >
          <Button variant="outline" onPress={onRemove} loading={removing} testID="provider-remove">
            {removing
              ? t("settings.providers.actions.removing")
              : t("settings.providers.remove.confirm")}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
