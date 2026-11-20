/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppearanceSection } from "./appearance-section";

const { platform, updateSettings } = vi.hoisted(() => ({
  platform: { native: false, compact: false },
  updateSettings: vi.fn(),
}));

vi.mock("@/constants/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/platform")>()),
  get isNative() {
    return platform.native;
  },
}));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => platform.compact,
}));
vi.mock("@/hooks/use-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-settings")>();
  return {
    ...actual,
    useAppSettings: () => ({ settings: actual.DEFAULT_CLIENT_SETTINGS, updateSettings }),
  };
});
vi.mock("@/appearance/theme-picker", () => ({ ThemePicker: () => null }));
vi.mock("./appearance-preview", () => ({ AppearancePreview: () => null }));

afterEach(() => {
  cleanup();
  updateSettings.mockClear();
});

it("shows the Web letter spacing field and hides it on native", () => {
  platform.native = false;
  const { rerender } = render(<AppearanceSection />);
  const label = "Content character spacing";
  expect(screen.getAllByLabelText(label)).toHaveLength(1);
  platform.native = true;
  rerender(<AppearanceSection />);
  expect(screen.queryByLabelText(label)).toBeNull();
});

it.each([
  { compact: true, defaultSpacing: 12, override: 16 },
  { compact: false, defaultSpacing: 16, override: 12 },
])("keeps the $defaultSpacing px paragraph default and saves an override", (input) => {
  platform.native = false;
  platform.compact = input.compact;
  render(<AppearanceSection />);
  const field = screen.getByLabelText<HTMLInputElement>("Paragraph spacing in pixels");
  expect(field.value).toBe(String(input.defaultSpacing));
  fireEvent.blur(field);
  expect(updateSettings).not.toHaveBeenCalled();

  fireEvent.change(field, { target: { value: String(input.override) } });
  fireEvent.blur(field);
  expect(updateSettings).toHaveBeenCalledExactlyOnceWith({
    contentParagraphSpacing: input.override,
  });
});
