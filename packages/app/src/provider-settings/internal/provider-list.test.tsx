/** @vitest-environment jsdom */
import { cleanup, render, within } from "@testing-library/react";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderInstallationRead } from "@/components/provider-installation";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderList } from "./provider-list";

const calls = vi.hoisted(() => ({ snapshot: vi.fn(), installation: vi.fn() }));

vi.mock("@/hooks/use-providers-snapshot", () => ({ useProvidersSnapshot: calls.snapshot }));
vi.mock("@/components/provider-installation", () => ({
  useProviderInstallation: calls.installation,
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeIsConnected: () => true }));
vi.mock("./provider-config", () => ({
  useProviderConfigActions: () => ({ setEnabled: () => {}, togglingProviderId: null }),
  useSupportsCustomProviderCli: () => false,
}));
vi.mock("./provider-glyph", () => ({ ProviderGlyph: () => null }));
vi.mock("./add-provider-sheet", () => ({ AddProviderSheet: () => null }));
vi.mock("./custom-provider-cli-form", () => ({ CustomProviderCliFormSheet: () => null }));

function entry(
  provider: string,
  enabled: boolean,
  status: ProviderSnapshotEntry["status"],
): ProviderSnapshotEntry {
  return { provider, enabled, status, models: [], modes: [] };
}

afterEach(cleanup);

it("orders settings by the displayed error and restores the order after an update failure clears", () => {
  calls.snapshot.mockReturnValue({
    isLoading: false,
    entries: [
      entry("disabled", false, "unavailable"),
      entry("catalog-error", true, "error"),
      entry("update-error", true, "ready"),
      entry("loading", true, "loading"),
      entry("unavailable", true, "unavailable"),
    ],
  });
  let failedHost: string | null = "first";
  calls.installation.mockImplementation(
    ({ serverId, provider }: { serverId: string; provider: string }): ProviderInstallationRead => ({
      state: { status: "unsupported" },
      updates: { status: "hidden" },
      action:
        serverId === failedHost && provider === "update-error"
          ? {
              starting: false,
              startError: null,
              start: () => {},
              current: {
                operation: {
                  status: "failed",
                  id: "u1",
                  startedAt: "2026-11-14T10:00:00Z",
                  finishedAt: "2026-11-14T10:01:00Z",
                  message: "Update failed",
                },
                output: [],
              },
            }
          : undefined,
      refresh: () => {},
      refreshing: false,
    }),
  );
  const onOpenProvider = vi.fn();
  const { getByTestId, rerender } = render(
    <ProviderList serverId="first" onOpenProvider={onOpenProvider} />,
  );
  const order = () =>
    within(getByTestId("provider-list"))
      .getAllByTestId(/^provider-row-/)
      .map((row) => row.dataset.testid?.replace("provider-row-", ""));
  const recovered = ["update-error", "loading", "unavailable", "disabled", "catalog-error"];

  expect(order()).toEqual(["loading", "unavailable", "disabled", "catalog-error", "update-error"]);
  const updateRow = getByTestId("provider-row-update-error");
  expect(updateRow.textContent).toContain("Update failed");

  failedHost = null;
  rerender(<ProviderList serverId="first" onOpenProvider={onOpenProvider} />);
  expect(order()).toEqual(recovered);
  expect(getByTestId("provider-row-update-error")).toBe(updateRow);

  failedHost = "first";
  rerender(<ProviderList serverId="first" onOpenProvider={onOpenProvider} />);
  expect(order().at(-1)).toBe("update-error");
  rerender(<ProviderList serverId="second" onOpenProvider={onOpenProvider} />);
  expect(order()).toEqual(recovered);
});
