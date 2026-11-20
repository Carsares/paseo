/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { UserMessageBody } from "./message-body";

void i18n;
afterEach(cleanup);

describe("UserMessageBody", () => {
  it("renders ordinary text without changing its whitespace", () => {
    const message = " Plain text\r\n\r\n2 > 1  ";
    const { container, queryByTestId } = render(<UserMessageBody message={message} />);

    expect(container.firstElementChild?.getAttribute("data-message-text")).toBe("true");
    expect(container.firstElementChild?.textContent).toBe(message);
    expect(queryByTestId("user-message-quote-block")).toBeNull();
  });

  it("renders quoted content in a card between the surrounding text segments", () => {
    const { container, getByTestId } = render(
      <UserMessageBody message={"Before\n> A quote\nAfter"} />,
    );
    const body = container.firstElementChild;
    const quote = getByTestId("user-message-quote-block");

    expect(body?.getAttribute("data-message-text")).toBe("true");
    expect(body?.firstElementChild?.textContent).toBe("Before");
    expect(quote.textContent).not.toContain(">");
    expect(
      within(quote).getByText("A quote", { selector: ":not([aria-hidden='true'])" }),
    ).toBeTruthy();
    expect(within(quote).queryByRole("button")).toBeNull();
    expect(body?.lastElementChild?.textContent).toBe("After");
  });

  it("expands and collapses one long quote without changing another", () => {
    const message = "> First\n> Second\n> Third\n> Fourth\n\n> Fifth\n> Sixth\n> Seventh\n> Eighth";
    const { getAllByTestId } = render(<UserMessageBody message={message} />);
    const [first, second] = getAllByTestId("user-message-quote-block").map((card) => within(card));
    const firstText = first.getByText("First Second Third Fourth");
    const firstToggle = first.getByRole("button", { name: "Show more" });

    expect(firstToggle.getAttribute("aria-expanded")).toBe("false");
    expect(getComputedStyle(firstText).textOverflow).toBe("ellipsis");
    fireEvent.click(firstToggle);
    expect(first.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(getComputedStyle(firstText).textOverflow).not.toBe("ellipsis");
    expect(second.getByRole("button", { name: "Show more" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    fireEvent.click(first.getByRole("button", { name: "Show less" }));
    expect(first.getByRole("button", { name: "Show more" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(getComputedStyle(firstText).textOverflow).toBe("ellipsis");
  });

  it("offers disclosure for a long quote on one source line", () => {
    const { getByTestId } = render(<UserMessageBody message={"> " + "Long quote ".repeat(20)} />);

    expect(getByTestId("user-message-quote-toggle").textContent).toBe("Show more");
  });
});
