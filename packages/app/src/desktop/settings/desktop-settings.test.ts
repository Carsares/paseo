// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { expect, test, vi } from "vitest";
import { getDesktopHost } from "@/desktop/host";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { DEFAULT_DESKTOP_SETTINGS, useDesktopSettings } from "./desktop-settings";

vi.mock("@/constants/platform", () => ({ getIsElectron: () => true }));
vi.mock("@/desktop/host", () => ({ getDesktopHost: vi.fn() }));
vi.mock("@/desktop/electron/invoke", () => ({ invokeDesktopCommand: vi.fn() }));
vi.mock("@/desktop/hooks/desktop-ipc-error", () => ({
  useDesktopIpcErrorReporter: () => () => {},
  useDesktopIpcQueryErrorToast: () => {},
}));
vi.mock("@/i18n/i18next", () => ({ i18n: { t: (key: string) => key } }));

test("applies a settings event from another window even while an older read is pending", async () => {
  const queryClient = new QueryClient();
  const subscription = Promise.withResolvers<(settings: unknown) => void>();
  const initialSettings = Promise.withResolvers<unknown>();
  const unlisten = vi.fn();
  const on = vi.fn((_event: string, listener: (settings: unknown) => void) => {
    subscription.resolve(listener);
    return Promise.resolve(unlisten);
  });
  vi.mocked(getDesktopHost).mockReturnValue({ events: { on } });
  vi.mocked(invokeDesktopCommand).mockReturnValue(initialSettings.promise);

  const { result, unmount } = renderHook(useDesktopSettings, {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  });
  const notify = await subscription.promise;
  expect(on).toHaveBeenCalledExactlyOnceWith("desktop-settings-changed", notify);
  expect(invokeDesktopCommand).toHaveBeenCalledExactlyOnceWith("get_desktop_settings");

  const changed = { ...DEFAULT_DESKTOP_SETTINGS, officialUpdatesEnabled: true };
  await act(async () => {
    notify(changed);
    initialSettings.resolve(DEFAULT_DESKTOP_SETTINGS);
  });
  await waitFor(() => expect(result.current.settings).toEqual(changed));
  expect(result.current.isLoading).toBe(false);
  unmount();
  await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  queryClient.clear();
});
