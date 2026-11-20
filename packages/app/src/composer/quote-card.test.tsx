/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createInstance } from "i18next";
import React, { type ComponentProps } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { en } from "@/i18n/resources/en";
import { zhCN } from "@/i18n/resources/zh-CN";
import { ComposerQuoteCardList } from "./quote-card";

beforeEach(() => vi.stubGlobal("React", React));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderQuotes(props: ComponentProps<typeof ComposerQuoteCardList>, locale = "en") {
  const i18n = createInstance();
  await i18n.init({
    lng: locale,
    resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <ComposerQuoteCardList {...props} />
    </I18nextProvider>,
  );
}

it.each([
  { locale: "en", titles: ["Quote 1", "Quote 2"] },
  { locale: "zh-CN", titles: ["引用 1", "引用 2"] },
])("numbers quote cards in display order in $locale", async ({ locale, titles }) => {
  const view = await renderQuotes(
    {
      quotes: [
        { id: "first", text: "First quote", attachmentIndex: 1 },
        { id: "second", text: "Second quote", attachmentIndex: 3 },
      ],
      onRemove: vi.fn(),
    },
    locale,
  );

  const cards = within(view.getByTestId("composer-quote-card-list")).getAllByTestId(
    "composer-quote-card",
  );
  expect(cards).toHaveLength(2);
  for (const [index, title] of titles.entries()) {
    expect(within(cards[index]).getByText(title)).toBeTruthy();
  }
});

it("omits the expand button for a short quote", async () => {
  const view = await renderQuotes({
    quotes: [{ id: "short", text: "A short quote", attachmentIndex: 0 }],
    onRemove: vi.fn(),
  });

  expect(view.queryByRole("button", { name: "Show more" })).toBeNull();
});

it.each([
  { label: "multiline", text: "First line\nSecond line\nThird line" },
  { label: "long", text: "A long quote ".repeat(12) },
])("expands and collapses a $label quote", async ({ text }) => {
  const view = await renderQuotes({
    quotes: [{ id: "overflowing", text, attachmentIndex: 0 }],
    onRemove: vi.fn(),
  });

  fireEvent.click(view.getByRole("button", { name: "Show more", expanded: false }));
  fireEvent.click(view.getByRole("button", { name: "Show less", expanded: true }));
  expect(view.getByRole("button", { name: "Show more", expanded: false })).toBeTruthy();
});

it("removes a quote by its index in the full attachment list", async () => {
  const onRemove = vi.fn();
  const view = await renderQuotes({
    quotes: [
      { id: "first", text: "First quote", attachmentIndex: 0 },
      { id: "second", text: "Second quote", attachmentIndex: 2 },
    ],
    onRemove,
  });

  fireEvent.click(view.getByRole("button", { name: "Remove quote 2" }));
  expect(onRemove).toHaveBeenCalledExactlyOnceWith(2);
});

it("updates the expand button when a short quote wraps at a different width", async () => {
  const layoutCallbacks = new Map<Element, () => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly onResize: (entries: { target: Element }[]) => void) {}

      observe(target: Element) {
        layoutCallbacks.set(target, () => this.onResize([{ target }]));
      }

      unobserve(target: Element) {
        layoutCallbacks.delete(target);
      }
    },
  );
  const text = "This short quote can wrap on a narrow screen";
  const view = await renderQuotes({
    quotes: [{ id: "wrap", text, attachmentIndex: 0 }],
    onRemove: vi.fn(),
  });
  const measurement = view.getByText(text, { selector: '[aria-hidden="true"]' });
  const layout = layoutCallbacks.get(measurement);
  expect(layout).toBeDefined();
  const width = vi.spyOn(measurement, "offsetWidth", "get").mockReturnValue(100);
  const height = vi.spyOn(measurement, "offsetHeight", "get").mockReturnValue(63);

  layout?.();
  expect(await view.findByRole("button", { name: "Show more" })).toBeTruthy();

  width.mockReturnValue(300);
  height.mockReturnValue(21);
  layout?.();
  await waitFor(() => expect(view.queryByRole("button", { name: "Show more" })).toBeNull());
});
