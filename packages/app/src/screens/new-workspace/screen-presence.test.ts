/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isNewWorkspaceScreenActive, useNewWorkspaceScreenPresence } from "./screen-presence";

const navigation = vi.hoisted(() => ({ isFocused: vi.fn() }));
vi.mock("expo-router", () => ({ usePathname: () => "/new" }));
vi.mock("expo-router/react-navigation", () => ({ useNavigation: () => navigation }));

describe("isNewWorkspaceScreenActive", () => {
  it("is active while its /new route instance is mounted and focused", () => {
    expect(isNewWorkspaceScreenActive({ isMounted: true, isFocused: true, pathname: "/new" })).toBe(
      true,
    );
  });

  it("is inactive once the screen has been popped off the stack", () => {
    expect(
      isNewWorkspaceScreenActive({ isMounted: false, isFocused: true, pathname: "/new" }),
    ).toBe(false);
  });

  it("is inactive while another route sits on top of the screen", () => {
    expect(
      isNewWorkspaceScreenActive({ isMounted: true, isFocused: false, pathname: "/settings" }),
    ).toBe(false);
  });

  it("is inactive when another /new route instance has focus", () => {
    expect(
      isNewWorkspaceScreenActive({ isMounted: true, isFocused: false, pathname: "/new" }),
    ).toBe(false);
  });

  it("is inactive on a workspace route", () => {
    expect(
      isNewWorkspaceScreenActive({
        isMounted: true,
        isFocused: true,
        pathname: "/host/workspace/wks_1",
      }),
    ).toBe(false);
  });
});

it("checks current route focus at receipt time even without a rerender", () => {
  navigation.isFocused.mockReturnValue(true);
  const { result, unmount } = renderHook(useNewWorkspaceScreenPresence);
  const isStillOnCreateScreen = result.current;
  expect(isStillOnCreateScreen()).toBe(true);

  navigation.isFocused.mockReturnValue(false);
  expect(isStillOnCreateScreen()).toBe(false);

  unmount();
  navigation.isFocused.mockReturnValue(true);
  expect(isStillOnCreateScreen()).toBe(false);
});
