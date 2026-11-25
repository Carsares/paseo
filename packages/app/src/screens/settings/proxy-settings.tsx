import { useFocusEffect, useIsFocused } from "expo-router/react-navigation";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SettingsAction, SettingsCard, SettingsSection } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { SelectField } from "@/components/ui/select-field";
import { getIsElectron } from "@/constants/platform";
import { useProxySettingsCopy } from "@/network/proxy/copy";
import { createDeviceProxyAdapter } from "@/network/proxy/device-adapter";
import { createHostProxyAdapter } from "@/network/proxy/host-adapter";
import { ProxySettingsForm } from "@/network/proxy/proxy-settings-form";
import type { ProxyTarget } from "@/network/proxy/settings";
import { getHostRuntimeStore, useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";

const deviceTarget = { kind: "device" } satisfies ProxyTarget;
const deviceAdapter = createDeviceProxyAdapter();

export function DeviceProxySettingsEntry() {
  const copy = useProxySettingsCopy();
  if (!getIsElectron()) return null;
  return (
    <ProxySettingsEntry title={copy.device}>
      <ProxySettingsForm target={deviceTarget} adapter={deviceAdapter} />
    </ProxySettingsEntry>
  );
}

export function HostProxySettingsEntry({ initialHostId }: { initialHostId: string }) {
  const copy = useProxySettingsCopy();
  return (
    <ProxySettingsEntry title={copy.host}>
      <HostProxySettings initialHostId={initialHostId} />
    </ProxySettingsEntry>
  );
}

function ProxySettingsEntry({ title, children }: { title: string; children: ReactNode }) {
  const copy = useProxySettingsCopy();
  const [isOpen, setOpen] = useState(false);
  const isFocused = useIsFocused();
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  useFocusEffect(useCallback(() => close, [close]));
  const header = useMemo(() => ({ title }), [title]);

  return (
    <SettingsSection title={copy.title}>
      <SettingsCard>
        <SettingsAction label={title} actionLabel={copy.configure} onPress={open} />
      </SettingsCard>
      {isFocused && isOpen ? (
        <AdaptiveModalSheet visible header={header} onClose={close} scrollable>
          {children}
        </AdaptiveModalSheet>
      ) : null}
    </SettingsSection>
  );
}

function HostProxySettings({ initialHostId }: { initialHostId: string }) {
  const copy = useProxySettingsCopy();
  const hosts = useHosts();
  const [hostId, setHostId] = useState(initialHostId);
  const selected = hosts.find((host) => host.serverId === hostId);
  const options = useMemo(
    () => hosts.map(({ serverId, label }) => ({ id: serverId, value: serverId, label })),
    [hosts],
  );
  const display = options.find((option) => option.value === hostId) ?? null;

  if (!hosts.length) return <Alert title={copy.noHosts} variant="info" />;

  return (
    <View style={styles.hostSettings}>
      <SelectField
        label={copy.selectHost}
        placeholder={copy.selectHost}
        emptyText={copy.noHosts}
        options={options}
        value={selected?.serverId ?? null}
        selectedDisplay={display}
        onChange={setHostId}
        searchable
      />
      {selected ? (
        <SelectedHostProxy
          key={selected.serverId}
          hostId={selected.serverId}
          label={selected.label}
        />
      ) : null}
    </View>
  );
}

function SelectedHostProxy({ hostId, label }: { hostId: string; label: string }) {
  const copy = useProxySettingsCopy();
  const runtime = useHostRuntimeSnapshot(hostId);
  const client = runtime?.client;
  const epoch = runtime?.connectionEpoch;
  const generation = runtime?.clientGeneration;
  const serverInfo = client?.getLastServerInfoMessage();
  const adapter = useMemo(() => {
    if (!client) return null;
    return createHostProxyAdapter({
      hostId,
      client,
      isCurrent() {
        const current = getHostRuntimeStore().getSnapshot(hostId);
        return (
          current?.client === client &&
          current.connectionEpoch === epoch &&
          current.connectionStatus === "online"
        );
      },
    });
  }, [client, epoch, hostId]);
  const target = useMemo<ProxyTarget>(() => ({ kind: "host", hostId }), [hostId]);

  if (!adapter || runtime?.connectionStatus !== "online" || !serverInfo) {
    return <Alert title={copy.waitingForHost} variant="info" />;
  }
  if (serverInfo.features?.outboundProxy !== true) {
    return <Alert title={copy.upgradeHost} variant="info" />;
  }
  return (
    <ProxySettingsForm
      key={`${generation}:${epoch}`}
      target={target}
      hostLabel={label}
      adapter={adapter}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  hostSettings: { gap: theme.spacing[4] },
}));
