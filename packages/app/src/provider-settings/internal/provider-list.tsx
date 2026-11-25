import { Plus } from "lucide-react-native";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useProviderInstallation } from "@/components/provider-installation";
import { SettingsAddRow, SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { orderProviders } from "@/provider-selection/provider-order";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { AddProviderSheet } from "./add-provider-sheet";
import { CustomProviderCliFormSheet } from "./custom-provider-cli-form";
import {
  useProviderConfigActions,
  useSupportsCustomProviderCli,
  type ProviderEntry,
} from "./provider-config";
import { ProviderGlyph } from "./provider-glyph";
import { ProviderNotice } from "./provider-notice";
import { ProviderRow } from "./provider-row";
import { readRowSummary } from "./row-summary";
import type { ProviderSheetFrame } from "./sheet-frame";

export interface ProviderListProps {
  serverId: string;
  /** Opens a provider's detail wherever the host shows it: a Settings page or a sheet. */
  onOpenProvider: (providerId: string) => void;
  /** Where the sheets the list opens sit. Defaults to a sheet over the current screen. */
  sheetFrame?: ProviderSheetFrame;
}

/** The host's providers, each saying how it is, and the way to add one. */
export function ProviderList({ serverId, onOpenProvider, sheetFrame }: ProviderListProps) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId) && serverId.length > 0;
  const { entries, isLoading } = useProvidersSnapshot(serverId);
  const { setEnabled, togglingProviderId } = useProviderConfigActions(serverId);
  const supportsCustomCli = useSupportsCustomProviderCli(serverId);
  const [adding, setAdding] = useState(false);
  const [addingCustomCli, setAddingCustomCli] = useState(false);
  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);
  const openAddCustomCli = useCallback(() => {
    setAdding(false);
    setAddingCustomCli(true);
  }, []);
  const closeAddCustomCli = useCallback(() => setAddingCustomCli(false), []);
  const handleAdded = useCallback(
    (providerId: string) => {
      setAdding(false);
      setAddingCustomCli(false);
      onOpenProvider(providerId);
    },
    [onOpenProvider],
  );

  const addButton = useMemo(
    () =>
      isConnected ? (
        <Button
          variant="ghost"
          leftIcon={Plus}
          onPress={openAdd}
          accessibilityLabel={t("settings.providers.addProvider")}
          testID="provider-list-add"
        >
          {t("settings.providers.list.add")}
        </Button>
      ) : null,
    [isConnected, openAdd, t],
  );

  let body: React.ReactNode;
  if (!isConnected) {
    body = <ProviderNotice message={t("settings.providers.unavailable")} />;
  } else if (isLoading) {
    body = <ProviderRowsSkeleton />;
  } else {
    body = (
      <ProviderRows
        key={serverId}
        serverId={serverId}
        entries={entries}
        togglingProviderId={togglingProviderId}
        onOpen={onOpenProvider}
        onToggle={setEnabled}
        onAdd={openAdd}
      />
    );
  }

  return (
    <>
      <SettingsSection
        title={t("settings.providers.title")}
        trailing={addButton}
        testID="host-page-providers-card"
      >
        {body}
      </SettingsSection>
      {isConnected ? (
        <>
          <AddProviderSheet
            serverId={serverId}
            visible={adding}
            onClose={closeAdd}
            onAdded={handleAdded}
            onAddCustomCli={supportsCustomCli ? openAddCustomCli : undefined}
            frame={sheetFrame}
          />
          {supportsCustomCli ? (
            <CustomProviderCliFormSheet
              mode="create"
              serverId={serverId}
              visible={addingCustomCli}
              onClose={closeAddCustomCli}
              onSaved={handleAdded}
              frame={sheetFrame}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

type ReportRowError = (provider: string, hasError: boolean | undefined) => void;

function ProviderRows({
  serverId,
  entries,
  togglingProviderId,
  onOpen,
  onToggle,
  onAdd,
}: {
  serverId: string;
  entries: readonly ProviderEntry[] | undefined;
  togglingProviderId: string | null;
  onOpen: (provider: string) => void;
  onToggle: (provider: string, enabled: boolean) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const reportError = useCallback<ReportRowError>((provider, hasError) => {
    setRowErrors((current) => {
      if (current.get(provider) === hasError) return current;
      const next = new Map(current);
      if (hasError === undefined) next.delete(provider);
      else next.set(provider, hasError);
      return next;
    });
  }, []);
  const orderedEntries = useMemo(
    () =>
      orderProviders(entries ?? [], (entry) => ({
        enabled: entry.enabled,
        hasError: rowErrors.get(entry.provider) ?? (entry.enabled && entry.status === "error"),
      })),
    [entries, rowErrors],
  );

  return (
    <SettingsCard testID="provider-list">
      {orderedEntries.map((entry) => (
        <ListedProvider
          key={entry.provider}
          serverId={serverId}
          entry={entry}
          toggling={togglingProviderId === entry.provider}
          onOpen={onOpen}
          onToggle={onToggle}
          reportError={reportError}
        />
      ))}
      <SettingsAddRow
        label={t("settings.providers.addProvider")}
        onPress={onAdd}
        testID="provider-list-add-row"
      />
    </SettingsCard>
  );
}

/** A row reads its provider's installation itself; the detail shares the same requests. */
function ListedProvider({
  serverId,
  entry,
  toggling,
  onOpen,
  onToggle,
  reportError,
}: {
  serverId: string;
  entry: ProviderEntry;
  toggling: boolean;
  onOpen: (provider: string) => void;
  onToggle: (provider: string, enabled: boolean) => void;
  reportError: ReportRowError;
}) {
  const installation = useProviderInstallation({
    serverId,
    provider: entry.provider,
    visible: true,
  });
  const icon = useMemo(
    () => <ProviderGlyph serverId={serverId} provider={entry.provider} />,
    [entry.provider, serverId],
  );
  const summary = readRowSummary(entry, installation);
  const hasError = summary.kind === "failing";
  const provider = entry.provider;
  useLayoutEffect(() => {
    reportError(provider, hasError);
    return () => reportError(provider, undefined);
  }, [provider, hasError, reportError]);
  return (
    <ProviderRow
      provider={provider}
      label={entry.label ?? provider}
      icon={icon}
      summary={summary}
      enabled={entry.enabled}
      toggling={toggling}
      onOpen={onOpen}
      onToggle={onToggle}
    />
  );
}

const SKELETON_ROW_KEYS = [0, 1, 2, 3].map((index) => `provider-skeleton-row-${index}`);

function ProviderRowsSkeleton() {
  const { t } = useTranslation();
  const pulse = useSkeletonPulse();
  return (
    <View
      style={settingsStyles.card}
      accessibilityLabel={t("settings.providers.loading")}
      testID="providers-skeleton"
    >
      {SKELETON_ROW_KEYS.map((key, index) => (
        <View key={key} style={[settingsStyles.row, index > 0 && settingsStyles.rowBorder]}>
          <View style={styles.skeletonContent}>
            <SkeletonPulse pulse={pulse} style={styles.skeletonIcon} />
            <SkeletonPulse pulse={pulse} style={styles.skeletonTitle} />
          </View>
          <SkeletonPulse pulse={pulse} style={styles.skeletonSwitch} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  skeletonContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  skeletonIcon: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  skeletonTitle: {
    width: 160,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  skeletonSwitch: {
    width: 36,
    height: 20,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
}));
