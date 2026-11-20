import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageExpansion } from "./expansion";

describe("assistant message expansion store", () => {
  it("tracks expanded steps per item and notifies only that item's subscribers", () => {
    const expansion = createAssistantMessageExpansion();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const unsubscribeFirst = expansion.subscribe("msg-1", firstListener);
    expansion.subscribe("msg-2", secondListener);

    expect(expansion.getSteps("msg-1")).toBe(0);

    expansion.showMore("msg-1");
    expect(expansion.getSteps("msg-1")).toBe(1);
    expect(expansion.getSteps("msg-2")).toBe(0);
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).not.toHaveBeenCalled();

    expansion.showMore("msg-1");
    expect(expansion.getSteps("msg-1")).toBe(2);
    expect(firstListener).toHaveBeenCalledTimes(2);

    expansion.showLess("msg-1");
    expect(expansion.getSteps("msg-1")).toBe(0);
    expect(firstListener).toHaveBeenCalledTimes(3);

    expansion.showLess("msg-1");
    expect(firstListener).toHaveBeenCalledTimes(3);

    unsubscribeFirst();
    expansion.showMore("msg-1");
    expect(firstListener).toHaveBeenCalledTimes(3);
  });
});
