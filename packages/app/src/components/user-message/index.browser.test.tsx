import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { MessagePreview } from "./index";
import { createUserMessageExpansion, type UserMessageExpansion } from "./expansion";
import { UserMessageExpansionContext } from "./expansion-context";
import { UserMessageBody } from "./message-body";

// Load translations so the toggle exposes its real accessible name.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  container.style.width = "400px";
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const longText = Array.from({ length: 60 }, (_, line) => `Line ${line + 1}`).join("\n");
const preLine = { whiteSpace: "pre-line" } as const;
const view = () => within(container);

function renderMessage(expansion: UserMessageExpansion) {
  act(() =>
    root.render(
      <UserMessageExpansionContext.Provider value={expansion}>
        <MessagePreview itemId="message-1">
          <span style={preLine}>{longText}</span>
        </MessagePreview>
      </UserMessageExpansionContext.Provider>,
    ),
  );
}

async function waitForLayout() {
  await act(async () => {
    for (let frame = 0; frame < 2; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
}

describe("long user message preview", () => {
  it("preserves the Python prompt in selected text alongside a quote card", () => {
    const code = ">>> 1 + 1";
    act(() => root.render(<UserMessageBody message={`${code}\n\n> Real quote`} />));
    const range = document.createRange();
    range.selectNodeContents(view().getByText(code, { exact: true }));
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe(code);
    expect(view().getAllByTestId("user-message-quote-block")).toHaveLength(1);
    selection.removeAllRanges();
  });

  it("removes the message height limit while the quote is expanded", async () => {
    const expansion = createUserMessageExpansion();
    const message = `${longText
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n\nReply`;
    act(() =>
      root.render(
        <UserMessageExpansionContext.Provider value={expansion}>
          <MessagePreview itemId="message-1">
            <UserMessageBody message={message} />
          </MessagePreview>
        </UserMessageExpansionContext.Provider>,
      ),
    );
    const quote = view().getByTestId("user-message-quote-block");
    const toggle = view().getByTestId("user-message-quote-toggle");
    const previewHeight = container.getBoundingClientRect().height;
    act(() => toggle.click());
    await waitForLayout();
    expect(quote.getBoundingClientRect().height).toBeGreaterThan(240);
    expect(container.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
      quote.getBoundingClientRect().bottom,
    );
    act(() => toggle.click());
    await waitForLayout();
    expect(container.getBoundingClientRect().height).toBe(previewHeight);
  });

  it("commits the control with the mount, so the first frame is the settled one", async () => {
    renderMessage(createUserMessageExpansion());

    // Nothing has painted yet: whatever is in the DOM now is the first frame.
    expect(view().getByRole("button", { name: "Show more" })).toBeTruthy();
    const firstFrameHeight = container.getBoundingClientRect().height;

    await waitForLayout();
    expect(view().getByRole("button", { name: "Show more" })).toBeTruthy();
    expect(container.getBoundingClientRect().height).toBe(firstFrameHeight);
  });

  it("paints the user's expanded choice when the row remounts", async () => {
    const expansion = createUserMessageExpansion();
    renderMessage(expansion);
    act(() => view().getByRole("button", { name: "Show more" }).click());
    await waitForLayout();
    const expandedHeight = container.getBoundingClientRect().height;

    act(() => root.render(null));
    renderMessage(expansion);

    expect(view().getByRole("button", { name: "Show less" })).toBeTruthy();
    expect(container.getBoundingClientRect().height).toBe(expandedHeight);
  });
});
