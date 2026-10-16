// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOverlayRegistration } from "./overlay-registration.web";
import { overlays } from "./overlays";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("selection overlay registration", () => {
  it("keeps listening after a modal closes while a passive selection remains", () => {
    const onQuoteKey = vi.fn(() => true);
    const onModalKey = vi.fn(() => true);
    const quote = renderHook(() =>
      useOverlayRegistration({
        active: true,
        keys: ["Enter"],
        layer: 100,
        passive: true,
        manageFocus: false,
        onKeyDown: onQuoteKey,
      }),
    );
    const modal = renderHook(() =>
      useOverlayRegistration({
        active: true,
        keys: ["Enter"],
        layer: 20,
        manageFocus: false,
        onKeyDown: onModalKey,
      }),
    );
    try {
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
      expect(onModalKey).toHaveBeenCalledTimes(1);
      expect(onQuoteKey).not.toHaveBeenCalled();
      modal.unmount();
      expect(overlays.hasActive()).toBe(false);
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
      expect(onQuoteKey).toHaveBeenCalledTimes(1);
    } finally {
      modal.unmount();
      quote.unmount();
    }
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
    expect(onQuoteKey).toHaveBeenCalledTimes(1);
    expect(overlays.getTop()).toBeUndefined();
  });
});
