import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, within } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { ProviderInstallationState } from "@/components/provider-installation-section";
import { i18n as testI18n } from "@/i18n/i18next";
import type {
  CustomProviderCliClient,
  CustomProviderCliResponse,
} from "./custom-provider-cli-form-model";

// Load real translations so controls expose their real accessible names and copy.
void testI18n;

const mocks = vi.hoisted(() => ({
  supportsCustomCli: true,
  config: null as MutableDaemonConfig | null,
  entries: [] as Array<{
    provider: string;
    status: "ready" | "loading" | "error" | "unavailable";
    enabled: boolean;
    source?: "builtin" | "custom";
    derivedFromProviderId?: string;
    label?: string;
    description?: string;
  }>,
  refreshSnapshot: vi.fn(async () => {}),
  isSnapshotRefreshing: false,
  refreshInstallation: vi.fn(),
  installationState: { status: "unsupported" } as ProviderInstallationState,
  installationRefreshing: false,
  hosts: [{ serverId: "host-1", label: "Mac Studio" }],
  hostname: "mac-studio.local" as string | null,
  client: null as CustomProviderCliClient | null,
  getProviderDiagnostic: vi.fn(async () => ({ diagnostic: "diag" })),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: mocks.config,
    isLoading: false,
    patchConfig: vi.fn(async () => mocks.config ?? undefined),
  }),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: mocks.entries,
    isLoading: false,
    isFetching: false,
    isRefreshing: mocks.isSnapshotRefreshing,
    error: null,
    supportsSnapshot: true,
    refresh: mocks.refreshSnapshot,
    refetchIfStale: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-acp-provider-catalog", () => ({
  useAcpProviderCatalog: () => ({
    entries: [
      {
        id: "gemini",
        title: "Google Gemini",
        description: "Gemini CLI",
        command: ["gemini", "--acp"],
      },
    ],
    loading: false,
    error: null,
    refetch: vi.fn(async () => []),
  }),
  getAcpProviderCatalog: () => [],
  readAcpProviderInstallGuide: () => null,
  buildAcpProviderConfigPatch: vi.fn(() => ({})),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mocks.hosts,
  useHostRuntimeIsConnected: () => true,
  useHostRuntimeClient: () => mocks.client,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    selector: (state: {
      sessions: Record<
        string,
        {
          serverInfo: {
            hostname: string | null;
            features: { providerCustomCli?: boolean; providerRemoval?: boolean };
          };
        }
      >;
    }) => unknown,
  ) =>
    selector({
      sessions: {
        "host-1": {
          serverInfo: {
            hostname: mocks.hostname,
            features: {
              providerCustomCli: mocks.supportsCustomCli,
              providerRemoval: true,
            },
          },
        },
        "host-2": {
          serverInfo: {
            hostname: "linux-box.local",
            features: {
              providerCustomCli: mocks.supportsCustomCli,
              providerRemoval: true,
            },
          },
        },
      },
    }),
}));

vi.mock("@/components/provider-installation", () => ({
  useProviderInstallation: () => ({
    state: mocks.installationState,
    updates: { status: "hidden" },
    action: undefined,
    refresh: mocks.refreshInstallation,
    refreshing: mocks.installationRefreshing,
  }),
}));

vi.mock("@/contexts/toast-api-context", () => ({
  useToast: () => ({
    error: vi.fn(),
    copied: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({
    error: vi.fn(),
    copied: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  }),
}));

import { AddProviderSheet } from "./add-provider-sheet";
import { CustomProviderCliFormSheet } from "./custom-provider-cli-form";
import { ProviderDetail, type ProviderDetailState } from "./provider-detail";

const mounted: { root: Root; container: HTMLDivElement }[] = [];

const BUILTIN_EDIT_TARGET = {
  targetKind: "builtin" as const,
  initialProvider: {
    providerId: "claude",
    command: ["/opt/claude-nightly", "--verbose"],
  },
};

const CUSTOM_EDIT_TARGET = {
  targetKind: "custom" as const,
  initialProvider: {
    providerId: "my-acp",
    extends: "acp",
    label: "Existing ACP",
    description: "Saved ACP agent",
    command: ["/usr/local/bin/my-acp", "--acp"],
  },
};

interface MockCustomProviderCliClient extends CustomProviderCliClient {
  locateCustomProviderCli: ReturnType<
    typeof vi.fn<CustomProviderCliClient["locateCustomProviderCli"]>
  >;
  testCustomProviderCli: ReturnType<typeof vi.fn<CustomProviderCliClient["testCustomProviderCli"]>>;
  saveCustomProviderCli: ReturnType<typeof vi.fn<CustomProviderCliClient["saveCustomProviderCli"]>>;
}

function createMockClient(
  overrides: Partial<MockCustomProviderCliClient> = {},
): MockCustomProviderCliClient {
  return {
    locateCustomProviderCli: vi.fn<CustomProviderCliClient["locateCustomProviderCli"]>(
      async () => ({
        requestId: "locate-1",
        result: { status: "ok", path: "/opt/bin/my-agent" },
      }),
    ),
    testCustomProviderCli: vi.fn<CustomProviderCliClient["testCustomProviderCli"]>(async () => ({
      requestId: "test-1",
      result: { status: "ok", path: "/opt/bin/my-agent" },
    })),
    saveCustomProviderCli: vi.fn<CustomProviderCliClient["saveCustomProviderCli"]>(async () => ({
      requestId: "save-1",
      result: { status: "ok", path: "/opt/bin/my-agent" },
    })),
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mountNode(node: React.ReactElement) {
  const queryClient = new QueryClient();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  mounted.push({ root, container });
  return {
    container,
    view: within(document.body),
    rerender: (nextNode: React.ReactElement) => {
      act(() => {
        root.render(<QueryClientProvider client={queryClient}>{nextNode}</QueryClientProvider>);
      });
    },
    unmount: () => {
      const idx = mounted.findIndex((item) => item.root === root);
      if (idx >= 0) mounted.splice(idx, 1);
      act(() => root.unmount());
      container.remove();
    },
  };
}

function typeInto(element: HTMLElement, value: string) {
  act(() => {
    fireEvent.change(element, { target: { value } });
  });
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.supportsCustomCli = true;
  mocks.config = {
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    providers: {
      claude: {
        command: ["/opt/claude-nightly", "--verbose"],
        env: { ANTHROPIC_API_KEY: "existing-secret-never-shown" },
      },
      "my-acp": {
        extends: "acp",
        label: "Existing ACP",
        description: "Saved ACP agent",
        command: ["/usr/local/bin/my-acp", "--acp"],
        env: { MY_SECRET: "persisted-secret-never-shown" },
      },
      antigravity: { enabled: true },
    },
  } as MutableDaemonConfig;
  mocks.entries = [
    {
      provider: "claude",
      status: "ready",
      enabled: true,
      source: "builtin",
      label: "Claude",
    },
    {
      provider: "my-acp",
      status: "ready",
      enabled: true,
      source: "custom",
      label: "Existing ACP",
      description: "Saved ACP agent",
    },
    {
      provider: "antigravity",
      status: "ready",
      enabled: true,
      source: "custom",
      label: "Antigravity",
    },
  ];
  mocks.hosts = [
    { serverId: "host-1", label: "Mac Studio" },
    { serverId: "host-2", label: "Linux Box" },
  ];
  mocks.hostname = "mac-studio.local";
  mocks.refreshSnapshot.mockReset();
  mocks.refreshSnapshot.mockImplementation(async () => {});
  mocks.isSnapshotRefreshing = false;
  mocks.refreshInstallation.mockReset();
  mocks.installationState = { status: "unsupported" };
  mocks.installationRefreshing = false;
  mocks.getProviderDiagnostic.mockClear();
  mocks.client = createMockClient();
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("custom CLI form UI", () => {
  it("keeps create flow quiet on mount, separates locate and test buttons, uses secure API key input, and saves without forced diagnostic refresh", async () => {
    const client = createMockClient();
    const onClose = vi.fn();
    const onSaved = vi.fn();

    const { view } = mountNode(
      <CustomProviderCliFormSheet
        mode="create"
        serverId="host-1"
        visible
        onClose={onClose}
        onSaved={onSaved}
        client={client}
      />,
    );

    // No silent launch or probe on mount.
    expect(client.locateCustomProviderCli).not.toHaveBeenCalled();
    expect(client.testCustomProviderCli).not.toHaveBeenCalled();
    expect(client.saveCustomProviderCli).not.toHaveBeenCalled();
    expect(view.getByTestId("custom-cli-host").textContent).toBe("Mac Studio");

    typeInto(view.getByTestId("custom-cli-provider-id-input"), "local-acp");
    typeInto(view.getByTestId("custom-cli-label-input"), "Local ACP");
    typeInto(view.getByTestId("custom-cli-executable-input"), "/opt/bin/local-acp");

    act(() => view.getByTestId("custom-cli-add-arg").click());
    typeInto(view.getByTestId("custom-cli-arg-0"), "  --acp  ");
    act(() => view.getByTestId("custom-cli-add-arg").click());
    act(() => view.getByTestId("custom-cli-arg-confirm-empty-1").click());
    // Unconfirmed newly added arg row must not be submitted.
    act(() => view.getByTestId("custom-cli-add-arg").click());

    typeInto(view.getByTestId("custom-cli-api-key-name"), "LOCAL_ACP_API_KEY");
    const apiKeyInput = view.getByTestId("custom-cli-api-key-value") as HTMLInputElement;
    expect(apiKeyInput.type).toBe("password");
    typeInto(apiKeyInput, "sk-write-only");

    // Step 1: Locate path button only locates without launching test.
    act(() => view.getByTestId("custom-cli-locate-button").click());
    await flushMicrotasks();

    expect(client.locateCustomProviderCli).toHaveBeenCalledTimes(1);
    expect(client.testCustomProviderCli).not.toHaveBeenCalled();
    expect(client.locateCustomProviderCli).toHaveBeenCalledWith({
      mode: "create",
      providerId: "local-acp",
      extends: "acp",
      label: "Local ACP",
      command: ["/opt/bin/local-acp", "  --acp  ", ""],
      env: { LOCAL_ACP_API_KEY: "sk-write-only" },
    });
    expect(view.getByTestId("custom-cli-locate-path").textContent).toBe("/opt/bin/my-agent");
    expect(view.getByTestId("custom-cli-host-path").textContent).toBe("/opt/bin/my-agent");

    // Step 2: Explicit Test launch & handshake button runs test separately.
    act(() => view.getByTestId("custom-cli-test-button").click());
    await flushMicrotasks();

    expect(client.testCustomProviderCli).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("custom-cli-test-result").textContent).toContain(
      "Launch and handshake succeeded",
    );

    // Step 3: Save submits draft and does not force a CLI-launching snapshot refresh.
    act(() => view.getByTestId("custom-cli-save").click());
    await flushMicrotasks();

    expect(client.saveCustomProviderCli).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith("local-acp");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.refreshSnapshot).not.toHaveBeenCalled();
    expect(mocks.getProviderDiagnostic).not.toHaveBeenCalled();
  });

  it("shields stale locate responses when the draft is edited or the host changes before completion", async () => {
    const deferredLocate = createDeferred<CustomProviderCliResponse>();
    const client = createMockClient({
      locateCustomProviderCli: vi.fn(() => deferredLocate.promise),
    });

    const { view, rerender } = mountNode(
      <CustomProviderCliFormSheet
        mode="create"
        serverId="host-1"
        visible
        onClose={vi.fn()}
        client={client}
      />,
    );

    typeInto(view.getByTestId("custom-cli-provider-id-input"), "stale-check");
    typeInto(view.getByTestId("custom-cli-label-input"), "Stale Check");
    typeInto(view.getByTestId("custom-cli-executable-input"), "/old/bin/agent");

    act(() => view.getByTestId("custom-cli-locate-button").click());
    // User edits executable before the locate response arrives.
    typeInto(view.getByTestId("custom-cli-executable-input"), "/new/bin/agent");

    deferredLocate.resolve({
      requestId: "stale-1",
      result: { status: "ok", path: "/old/bin/agent" },
    });
    await flushMicrotasks();

    expect(view.queryByTestId("custom-cli-locate-result")).toBeNull();
    expect(view.getByTestId("custom-cli-host-path").textContent).toBe("/new/bin/agent");

    // Switching hosts remounts fresh with the new host label and empty draft.
    rerender(
      <CustomProviderCliFormSheet
        mode="create"
        serverId="host-2"
        visible
        onClose={vi.fn()}
        client={client}
      />,
    );

    expect(view.getByTestId("custom-cli-host").textContent).toBe("Linux Box");
    expect((view.getByTestId("custom-cli-provider-id-input") as HTMLInputElement).value).toBe("");
  });

  it("seeds edit mode for built-in overrides and custom providers without ever showing saved secrets", async () => {
    const client = createMockClient({
      testCustomProviderCli: vi.fn(
        async (): Promise<CustomProviderCliResponse> => ({
          requestId: "test-blocked",
          result: { status: "blocked" },
        }),
      ),
    });

    const { view, rerender } = mountNode(
      <CustomProviderCliFormSheet
        mode="edit"
        target={BUILTIN_EDIT_TARGET}
        serverId="host-1"
        visible
        onClose={vi.fn()}
        client={client}
      />,
    );

    expect(view.getByTestId("custom-cli-id-readonly").textContent).toBe("claude");
    expect(view.queryByTestId("custom-cli-extends-readonly")).toBeNull();
    expect(view.queryByTestId("custom-cli-extends-trigger")).toBeNull();
    expect((view.getByTestId("custom-cli-executable-input") as HTMLInputElement).value).toBe(
      "/opt/claude-nightly",
    );
    expect((view.getByTestId("custom-cli-arg-0") as HTMLInputElement).value).toBe("--verbose");
    expect((view.getByTestId("custom-cli-api-key-value") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("existing-secret-never-shown");

    // Status-mapped explanation for blocked launch test.
    act(() => view.getByTestId("custom-cli-test-button").click());
    await flushMicrotasks();
    expect(view.getByTestId("custom-cli-test-result").textContent).toContain("Launch blocked");

    // Switch to custom ACP edit: locks both providerId and extends, keeps env empty.
    rerender(
      <CustomProviderCliFormSheet
        mode="edit"
        target={CUSTOM_EDIT_TARGET}
        serverId="host-1"
        visible
        onClose={vi.fn()}
        client={client}
      />,
    );

    expect(view.getByTestId("custom-cli-id-readonly").textContent).toBe("my-acp");
    expect(view.getByTestId("custom-cli-extends-readonly").textContent).toContain("ACP");
    expect((view.getByTestId("custom-cli-label-input") as HTMLInputElement).value).toBe(
      "Existing ACP",
    );
    expect((view.getByTestId("custom-cli-api-key-value") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("persisted-secret-never-shown");
  });

  it("hides custom CLI entry points on unsupported hosts and on external plugin providers", () => {
    mocks.supportsCustomCli = false;
    const { view, rerender } = mountNode(
      <AddProviderSheet serverId="host-1" visible onClose={vi.fn()} onAdded={vi.fn()} />,
    );
    expect(view.queryByTestId("add-custom-cli-provider")).toBeNull();

    mocks.supportsCustomCli = true;
    rerender(<AddProviderSheet serverId="host-1" visible onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(view.queryByTestId("add-custom-cli-provider")).not.toBeNull();

    const makeDetail = (provider: string): ProviderDetailState => {
      const entry = mocks.entries.find((item) => item.provider === provider)!;
      return {
        provider,
        label: entry.label ?? provider,
        presence: { kind: "found", entry },
        canRemove: () => false,
        removing: false,
        remove: vi.fn(),
      };
    };

    // Built-in provider shows Override CLI when supported.
    rerender(<ProviderDetail serverId="host-1" detail={makeDetail("claude")} />);
    expect(view.queryByTestId("provider-edit-custom-cli")).not.toBeNull();
    expect(view.getByTestId("provider-edit-custom-cli").textContent).toContain("Override CLI");

    // External plugin provider hides edit entry so it never impersonates a built-in.
    rerender(<ProviderDetail serverId="host-1" detail={makeDetail("antigravity")} />);
    expect(view.queryByTestId("provider-edit-custom-cli")).toBeNull();

    // Unsupported host hides edit entry even for built-in provider.
    mocks.supportsCustomCli = false;
    rerender(<ProviderDetail serverId="host-1" detail={makeDetail("claude")} />);
    expect(view.queryByTestId("provider-edit-custom-cli")).toBeNull();
  });

  it("submits only modified label and cleared description in edit mode, locks inputs during save, explains reload_required vs generic blocked, and retries cleanly", async () => {
    const firstSave = createDeferred<CustomProviderCliResponse>();
    const secondSave = createDeferred<CustomProviderCliResponse>();
    const retrySave = createDeferred<CustomProviderCliResponse>();
    const saveMock = vi
      .fn<CustomProviderCliClient["saveCustomProviderCli"]>()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise)
      .mockImplementationOnce(() => retrySave.promise);
    const client = createMockClient({ saveCustomProviderCli: saveMock });
    const onClose = vi.fn();
    const onSaved = vi.fn();

    const { view } = mountNode(
      <CustomProviderCliFormSheet
        mode="edit"
        target={CUSTOM_EDIT_TARGET}
        serverId="host-1"
        visible
        onClose={onClose}
        onSaved={onSaved}
        client={client}
      />,
    );

    // Edit ONLY label and clear description; leave pre-loaded command untouched.
    typeInto(view.getByTestId("custom-cli-label-input"), "Renamed ACP");
    typeInto(view.getByTestId("custom-cli-description-input"), "");

    act(() => view.getByTestId("custom-cli-save").click());
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenLastCalledWith({
      mode: "edit",
      providerId: "my-acp",
      extends: "acp",
      label: "Renamed ACP",
      description: "",
    });

    // While save is pending, inputs are disabled and clicking save again does not send a second request.
    const labelInput = view.getByTestId("custom-cli-label-input") as HTMLInputElement;
    expect(labelInput.readOnly || labelInput.disabled).toBe(true);
    act(() => view.getByTestId("custom-cli-save").click());
    expect(saveMock).toHaveBeenCalledTimes(1);

    // First save returns blocked with reason reload_required -> shows targeted reload guidance, not generic Save blocked.
    firstSave.resolve({
      requestId: "save-1",
      result: { status: "blocked", reason: "reload_required" },
    });
    await flushMicrotasks();

    expect(onClose).not.toHaveBeenCalled();
    const reloadAlert = view.getByTestId("custom-cli-save-error").textContent ?? "";
    expect(reloadAlert).toContain("Reload host configuration first");
    expect(reloadAlert).toContain("Reload configuration on Mac Studio");
    expect(reloadAlert).not.toContain("Save blocked");
    expect(labelInput.readOnly || labelInput.disabled).toBe(false);

    // Second save returns plain blocked without reason -> preserves existing generic blocked guidance.
    act(() => view.getByTestId("custom-cli-save").click());
    expect(saveMock).toHaveBeenCalledTimes(2);
    secondSave.resolve({ requestId: "save-2", result: { status: "blocked" } });
    await flushMicrotasks();

    const blockedAlert = view.getByTestId("custom-cli-save-error").textContent ?? "";
    expect(blockedAlert).toContain("Save blocked");
    expect(blockedAlert).not.toContain("Reload host configuration first");

    // Third save succeeds -> notifies onSaved and closes.
    act(() => view.getByTestId("custom-cli-save").click());
    expect(saveMock).toHaveBeenCalledTimes(3);
    retrySave.resolve({ requestId: "save-3", result: { status: "ok" } });
    await flushMicrotasks();

    expect(onSaved).toHaveBeenCalledWith("my-acp");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reads the installed version after explicitly refreshing an unavailable custom CLI", async () => {
    const entry = {
      ...mocks.entries.find(({ provider }) => provider === "my-acp")!,
      status: "unavailable",
    } as const;
    const discovery = createDeferred<void>();
    mocks.refreshSnapshot.mockReturnValueOnce(discovery.promise);
    const makeDetail = (): ProviderDetailState => ({
      provider: entry.provider,
      label: entry.label ?? entry.provider,
      presence: { kind: "found", entry },
      canRemove: () => false,
      removing: false,
      remove: vi.fn(),
    });
    const { view } = mountNode(<ProviderDetail serverId="host-1" detail={makeDetail()} />);

    act(() => view.getByTestId("provider-refresh").click());
    expect(mocks.refreshSnapshot).toHaveBeenCalledWith([entry.provider]);
    expect(mocks.refreshInstallation).not.toHaveBeenCalled();

    await act(async () => discovery.resolve());
    expect(mocks.refreshInstallation).toHaveBeenCalledOnce();
  });

  it("waits for host discovery before reading installation when retrying from error to ready and clears loading state", async () => {
    const order: string[] = [];
    const discovery = createDeferred<void>();
    // Simulate a provider that failed its initial discovery (status: "error") even before config loads.
    mocks.config = null;
    mocks.installationState = {
      status: "ready",
      installation: { inspection: { status: "installed" } },
    };
    const errorEntry = {
      ...mocks.entries.find(({ provider }) => provider === "my-acp")!,
      status: "error" as const,
      error: "Initial discovery failed",
    };
    const readyEntry = {
      ...errorEntry,
      status: "ready" as const,
      error: undefined,
    };
    const makeDetail = (entry: typeof errorEntry | typeof readyEntry): ProviderDetailState => ({
      provider: entry.provider,
      label: entry.label ?? entry.provider,
      presence: { kind: "found", entry },
      canRemove: () => false,
      removing: false,
      remove: vi.fn(),
    });

    const { view, rerender } = mountNode(
      <ProviderDetail serverId="host-1" detail={makeDetail(errorEntry)} />,
    );

    expect(view.queryByTestId("provider-installation-version")).toBeNull();
    expect(view.getByTestId("provider-refresh").textContent).toBe("Refresh");

    mocks.refreshSnapshot.mockImplementationOnce(() => {
      order.push("discovery:start");
      mocks.isSnapshotRefreshing = true;
      return discovery.promise;
    });
    mocks.refreshInstallation.mockImplementationOnce(() => {
      order.push("installation:refresh");
      mocks.installationRefreshing = false;
      mocks.installationState = {
        status: "ready",
        installation: { inspection: { status: "installed", version: "2.4.0" } },
      };
      rerender(<ProviderDetail serverId="host-1" detail={makeDetail(readyEntry)} />);
    });

    act(() => view.getByTestId("provider-refresh").click());
    rerender(<ProviderDetail serverId="host-1" detail={makeDetail(errorEntry)} />);

    expect(mocks.refreshSnapshot).toHaveBeenCalledWith(["my-acp"]);
    expect(mocks.refreshInstallation).not.toHaveBeenCalled();
    expect(order).toEqual(["discovery:start"]);
    expect(view.getByTestId("provider-refresh").textContent).toBe("Refreshing...");

    await act(async () => {
      order.push("discovery:resolved");
      mocks.isSnapshotRefreshing = false;
      discovery.resolve();
      await Promise.resolve();
    });
    rerender(<ProviderDetail serverId="host-1" detail={makeDetail(readyEntry)} />);

    expect(order).toEqual(["discovery:start", "discovery:resolved", "installation:refresh"]);
    expect(mocks.refreshInstallation).toHaveBeenCalledOnce();
    expect(view.getByTestId("provider-installation-version").textContent).toBe("2.4.0");
    expect(view.getByTestId("provider-refresh").textContent).toBe("Refresh");
  });

  it("still refreshes installation without leaving loading stuck when discovery fails, and skips stale refreshes after unmount", async () => {
    const failedDiscovery = createDeferred<void>();
    const errorEntry = {
      ...mocks.entries.find(({ provider }) => provider === "my-acp")!,
      status: "error" as const,
      error: "Discovery failed",
    };
    const makeDetail = (): ProviderDetailState => ({
      provider: errorEntry.provider,
      label: errorEntry.label ?? errorEntry.provider,
      presence: { kind: "found", entry: errorEntry },
      canRemove: () => false,
      removing: false,
      remove: vi.fn(),
    });

    mocks.refreshSnapshot.mockImplementationOnce(() => {
      mocks.isSnapshotRefreshing = true;
      return failedDiscovery.promise;
    });

    const { view, rerender, unmount } = mountNode(
      <ProviderDetail serverId="host-1" detail={makeDetail()} />,
    );

    act(() => view.getByTestId("provider-refresh").click());
    rerender(<ProviderDetail serverId="host-1" detail={makeDetail()} />);
    expect(mocks.refreshInstallation).not.toHaveBeenCalled();
    expect(view.getByTestId("provider-refresh").textContent).toBe("Refreshing...");

    await act(async () => {
      mocks.isSnapshotRefreshing = false;
      failedDiscovery.reject(new Error("Host refresh failed"));
      await Promise.resolve();
    });
    rerender(<ProviderDetail serverId="host-1" detail={makeDetail()} />);

    expect(mocks.refreshInstallation).toHaveBeenCalledOnce();
    expect(view.getByTestId("provider-refresh").textContent).toBe("Refresh");

    // Unmounting while a refresh is in flight prevents stale installation calls once it settles.
    const staleDiscovery = createDeferred<void>();
    mocks.refreshSnapshot.mockReturnValueOnce(staleDiscovery.promise);
    mocks.refreshInstallation.mockClear();

    act(() => view.getByTestId("provider-refresh").click());
    unmount();

    await act(async () => {
      staleDiscovery.resolve();
      await Promise.resolve();
    });
    expect(mocks.refreshInstallation).not.toHaveBeenCalled();
  });
});
