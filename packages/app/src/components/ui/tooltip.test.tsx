import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip, TooltipTrigger } from "./tooltip";

const runtime = vi.hoisted(() => ({ isNative: false, isCompact: false }));

vi.mock("@/constants/platform", () => ({
  get isWeb() {
    return !runtime.isNative;
  },
  get isNative() {
    return runtime.isNative;
  },
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => runtime.isCompact,
}));

vi.mock("@gorhom/portal", () => ({
  Portal: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@gorhom/bottom-sheet", () => ({
  useBottomSheetModalInternal: () => null,
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
  },
  FadeIn: {},
  FadeOut: {},
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (styles: unknown) => styles,
  },
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  runtime.isNative = false;
  runtime.isCompact = false;
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function renderTrigger({
  childDisabled,
  onPress,
  onOpenChange,
  enabledOnMobile,
  enabledOnCompactWeb,
}: {
  childDisabled: boolean;
  onPress: () => void;
  onOpenChange?: (open: boolean) => void;
  enabledOnMobile?: boolean;
  enabledOnCompactWeb?: boolean;
}): void {
  act(() => {
    root?.render(
      <Tooltip
        onOpenChange={onOpenChange}
        enabledOnMobile={enabledOnMobile}
        enabledOnCompactWeb={enabledOnCompactWeb}
      >
        <TooltipTrigger asChild>
          <Pressable disabled={childDisabled} onPress={onPress} testID="trigger">
            <Text>Send</Text>
          </Pressable>
        </TooltipTrigger>
      </Tooltip>,
    );
  });
}

function pressTrigger(): void {
  const trigger = container?.querySelector('[data-testid="trigger"]');
  expect(trigger).not.toBeNull();

  act(() => {
    trigger?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

describe("TooltipTrigger", () => {
  it("keeps an asChild trigger disabled when the child is disabled", () => {
    const onPress = vi.fn();

    renderTrigger({ childDisabled: true, onPress });
    pressTrigger();

    expect(onPress).not.toHaveBeenCalled();
  });

  it("keeps an asChild trigger interactive when the child is not disabled", () => {
    const onPress = vi.fn();

    renderTrigger({ childDisabled: false, onPress });
    pressTrigger();

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("Tooltip press behavior", () => {
  it("keeps compact web tooltips disabled by default and honors existing mobile opt-ins", () => {
    runtime.isCompact = true;
    const onPress = vi.fn();
    const onOpenChange = vi.fn();
    renderTrigger({ childDisabled: false, onPress, onOpenChange });

    pressTrigger();

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();

    renderTrigger({ childDisabled: false, onPress, onOpenChange, enabledOnMobile: true });
    pressTrigger();

    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("uses desktop press behavior when compact web and mobile are both enabled", () => {
    runtime.isCompact = true;
    const onPress = vi.fn();
    const onOpenChange = vi.fn();
    renderTrigger({
      childDisabled: false,
      onPress,
      onOpenChange,
      enabledOnMobile: true,
      enabledOnCompactWeb: true,
    });

    pressTrigger();

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([false, true])(
    "preserves native press behavior (enabledOnMobile=%s)",
    (enabledOnMobile) => {
      runtime.isNative = true;
      runtime.isCompact = true;
      const onPress = vi.fn();
      const onOpenChange = vi.fn();
      renderTrigger({
        childDisabled: false,
        onPress,
        onOpenChange,
        enabledOnMobile,
        enabledOnCompactWeb: true,
      });

      pressTrigger();

      expect(onPress).toHaveBeenCalledTimes(1);
      if (enabledOnMobile) expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
      else expect(onOpenChange).not.toHaveBeenCalled();
    },
  );
});
