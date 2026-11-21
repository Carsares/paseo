// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { ActivePromptBar } from "./active-prompt-bar";
import { createActivePromptPublisher, type ChatOutlinePrompt } from "./model";

vi.mock("lucide-react-native", async (importOriginal) => {
  const icons = await importOriginal<typeof import("lucide-react-native")>();
  return { ...icons, ChevronUp: icons.ChevronDown };
});

const prompts: readonly ChatOutlinePrompt[] = [
  { seq: 4, timestamp: new Date(4).toISOString(), preview: "First question" },
  { seq: 9, timestamp: new Date(9).toISOString(), preview: "Second question" },
  { seq: 21, timestamp: new Date(21).toISOString(), preview: "Third question" },
];

function renderBar(index: readonly ChatOutlinePrompt[] = prompts) {
  const activePrompt = createActivePromptPublisher();
  const onJumpToPrompt = vi.fn();
  const view = render(
    <ActivePromptBar
      prompts={index}
      activePrompt={activePrompt}
      contentMaxWidth={720}
      onJumpToPrompt={onJumpToPrompt}
    />,
  );
  return { ...view, activePrompt, onJumpToPrompt };
}

describe("ActivePromptBar", () => {
  afterEach(async () => {
    cleanup();
    if (i18n.language !== "en") {
      await i18n.changeLanguage("en");
    }
  });

  it("shows the current prompt only after its row has scrolled above the viewport", () => {
    const { activePrompt, queryByTestId, getByText } = renderBar();
    act(() => activePrompt.publish(9, false));
    expect(queryByTestId("active-prompt-bar")).toBeNull();

    act(() => activePrompt.publish(9, true));
    expect(getByText("Prompt 2/3")).toBeTruthy();
    expect(getByText("Second question")).toBeTruthy();

    act(() => activePrompt.publish(9, false));
    expect(queryByTestId("active-prompt-bar")).toBeNull();
  });

  it("yields to chat find in the same transcript until find closes", () => {
    const activePrompt = createActivePromptPublisher();
    activePrompt.publish(9, true);
    const transcript = (findOpen: boolean) => (
      <>
        <div>
          <ActivePromptBar
            prompts={prompts}
            activePrompt={activePrompt}
            contentMaxWidth={720}
            onJumpToPrompt={vi.fn()}
          />
          {findOpen ? <div data-chat-find-widget="true" /> : null}
        </div>
        <div>
          <div data-chat-find-widget="true" />
        </div>
      </>
    );
    const { getByRole, queryByRole, rerender } = render(transcript(false));
    const currentPrompt = { name: "Prompt 2/3: Second question" };

    expect(getByRole("button", currentPrompt)).toBeTruthy();
    rerender(transcript(true));
    expect(queryByRole("button", currentPrompt)).toBeNull();
    rerender(transcript(false));
    expect(getByRole("button", currentPrompt)).toBeTruthy();
  });

  it("renders a single prompt and disables both adjacent jumps", () => {
    const { activePrompt, getByText, getByTestId, onJumpToPrompt } = renderBar(prompts.slice(0, 1));
    act(() => activePrompt.publish(4, true));

    expect(getByText("Prompt 1/1")).toBeTruthy();
    const previous = getByTestId("active-prompt-bar-prev");
    const next = getByTestId("active-prompt-bar-next");
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(next.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(previous);
    fireEvent.click(next);
    expect(onJumpToPrompt).not.toHaveBeenCalled();
  });

  it("jumps to the current, previous, and next prompt by sequence", () => {
    const { activePrompt, getByTestId, onJumpToPrompt } = renderBar();
    act(() => activePrompt.publish(9, true));

    fireEvent.click(getByTestId("active-prompt-bar-jump-current"));
    fireEvent.click(getByTestId("active-prompt-bar-prev"));
    fireEvent.click(getByTestId("active-prompt-bar-next"));
    expect(onJumpToPrompt.mock.calls).toEqual([[9], [4], [21]]);
  });

  it("uses the app language for the count and navigation controls", async () => {
    const { activePrompt, getByText, getByRole } = renderBar();
    act(() => activePrompt.publish(9, true));
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });

    expect(getByText("第 2/3 问")).toBeTruthy();
    expect(getByRole("button", { name: "上一问" })).toBeTruthy();
    expect(getByRole("button", { name: "下一问" })).toBeTruthy();
  });
});
