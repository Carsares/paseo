/**
 * @vitest-environment jsdom
 */
import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCrossProviderSwitchDisclosurePlan } from "./model-sheet-flow";
import { ProviderSwitchDisclosureModal } from "./provider-switch-disclosure";

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return { ...actual, useIsCompactFormFactor: () => false };
});

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeaderSubtitle: ({ text }: { text: string }) => <span>{text}</span>,
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ title }: { title: string }) => <div role="alert">{title}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onPress,
    testID,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button type="button" disabled={disabled} data-testid={testID} onClick={onPress}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/press-highlight", () => ({
  PressHighlight: ({
    children,
    disabled,
    onPress,
    testID,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button type="button" disabled={disabled} data-testid={testID} onClick={onPress}>
      {children}
    </button>
  ),
}));

const planWithFrozenRunning = {
  ...buildCrossProviderSwitchDisclosurePlan({
    sourceProvider: "codex",
    sourceProviderLabel: "Codex",
    targetProvider: "claude",
    targetProviderLabel: "Claude Code",
    targetModelId: "claude-sonnet",
    targetModelLabel: "Sonnet",
    targetModel: null,
    currentThinkingOptionId: null,
    agentStatus: "running",
    turnPhase: "open",
    hasConversationHistory: true,
    topicMetadataState: { status: "present", hideFromModel: false },
    hasWorkspaceTaskLedger: true,
    hasRolePrompt: true,
    pendingPermissionsCount: 0,
    supportsAtomicBlankContextSwitch: true,
  }),
  disclosureChangedReason: "session" as const,
};

beforeEach(() => vi.stubGlobal("React", React));

describe("ProviderSwitchDisclosureModal", () => {
  it("re-enables confirm and clears running alert when live agent status settles without reopening", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    const view = render(
      <ProviderSwitchDisclosureModal
        plan={planWithFrozenRunning}
        isRunning
        pending={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const confirmButton = view.getByTestId("provider-switch-confirm") as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    expect(
      view.queryByText("topicWorkbench.modelSwitch.runningWaitNote") ??
        view.queryByText(/currently running|正在运行/i),
    ).not.toBeNull();

    fireEvent.click(confirmButton);
    expect(onConfirm).not.toHaveBeenCalled();

    // Live subscribed agent settles to idle while keeping the same disclosure plan open.
    view.rerender(
      <ProviderSwitchDisclosureModal
        plan={planWithFrozenRunning}
        isRunning={false}
        pending={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(confirmButton.disabled).toBe(false);
    expect(view.queryByText("topicWorkbench.modelSwitch.runningWaitNote")).toBeNull();
    expect(view.queryByText(/currently running|正在运行/i)).toBeNull();

    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("carry-summary");
  });
});
