/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, type ChangeEvent, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProxySettingsFormProps } from "@/network/proxy/proxy-settings-form";
import { DeviceProxySettingsEntry, HostProxySettingsEntry } from "./proxy-settings";

const state = vi.hoisted(() => {
  const host = {
    client: {
      getLastServerInfoMessage: () => ({ features: { outboundProxy: true } }),
      getOutboundProxy: vi.fn(async () => ({ status: "unavailable" })),
    },
    connectionStatus: "online",
    connectionEpoch: 1,
    clientGeneration: 1,
  };
  return {
    desktop: false,
    language: "en",
    hosts: [
      { serverId: "office", label: "Office" },
      { serverId: "home", label: "Home" },
    ],
    office: {
      ...host,
      client: {
        ...host.client,
        getLastServerInfoMessage: () => ({ features: {} }),
        getOutboundProxy: vi.fn(),
      },
    },
    home: host,
  };
});

vi.mock("expo-router/react-navigation", () => ({
  useFocusEffect: vi.fn(),
  useIsFocused: () => true,
}));
vi.mock("@/constants/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/platform")>()),
  getIsElectron: () => state.desktop,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { resolvedLanguage: state.language } }),
}));
vi.mock("@/runtime/host-runtime", () => {
  const getSnapshot = (id: string) => (id === "office" ? state.office : state.home);
  return {
    getHostRuntimeStore: () => ({ getSnapshot }),
    useHostRuntimeSnapshot: getSnapshot,
    useHosts: () => state.hosts,
  };
});
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/settings", () => ({
  SettingsAction: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
  SettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("@/components/ui/alert", () => ({
  Alert: ({ title }: { title: string }) => <span>{title}</span>,
}));
vi.mock("@/components/ui/select-field", () => ({
  SelectField: ({
    label,
    options,
    value,
    onChange,
  }: {
    label: string;
    options: { id: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
  }) => {
    const select = useCallback(
      (event: ChangeEvent<HTMLSelectElement>) => onChange(event.currentTarget.value),
      [onChange],
    );
    return (
      <select aria-label={label} value={value} onChange={select}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    );
  },
}));
vi.mock("@/network/proxy/proxy-settings-form", () => ({
  ProxySettingsForm: ({ adapter, target, hostLabel }: ProxySettingsFormProps) => {
    const load = useCallback(() => {
      void adapter.load(target, new AbortController().signal);
    }, [adapter, target]);
    return (
      <button type="button" onClick={load}>
        {hostLabel ?? "This device"}
      </button>
    );
  },
}));

afterEach(() => {
  cleanup();
  state.desktop = false;
  state.language = "en";
  vi.clearAllMocks();
});

it("shows the device entry only in Electron", () => {
  const view = render(<DeviceProxySettingsEntry />);
  expect(screen.queryByRole("button", { name: "This device" })).toBeNull();
  state.desktop = true;
  view.rerender(<DeviceProxySettingsEntry />);
  fireEvent.click(screen.getByRole("button", { name: "This device" }));
  expect(screen.getAllByRole("button", { name: "This device" })).toHaveLength(2);
});

it("gates the selected host on its own capability and sends requests to that client", () => {
  render(<HostProxySettingsEntry initialHostId="office" />);
  fireEvent.click(screen.getByRole("button", { name: "Host" }));
  expect(screen.getByText("Update this host to configure its proxy.")).toBeTruthy();
  expect(state.office.client.getOutboundProxy).not.toHaveBeenCalled();

  fireEvent.change(screen.getByRole("combobox", { name: "Select a host" }), {
    target: { value: "home" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Home" }));
  expect(state.home.client.getOutboundProxy).toHaveBeenCalledWith({});
  expect(state.office.client.getOutboundProxy).not.toHaveBeenCalled();
});

it("uses the Simplified Chinese titles for both proxy entries", () => {
  state.desktop = true;
  state.language = "zh-CN";
  render(
    <>
      <DeviceProxySettingsEntry />
      <HostProxySettingsEntry initialHostId="office" />
    </>,
  );
  expect(screen.getByRole("button", { name: "此设备" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "指定宿主" }));
  expect(screen.getByRole("combobox", { name: "选择宿主" })).toBeTruthy();
  expect(screen.getByText("更新此宿主后可配置它的代理。")).toBeTruthy();
});
