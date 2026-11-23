// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { DraftTitleEditor } from "./draft-title-editor";

afterEach(cleanup);

function startEditing() {
  const name = i18n.t("newWorkspace.editTitle");
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("textbox", { name });
}

describe("DraftTitleEditor", () => {
  it("keeps the Chinese candidate in the input until a separate Enter submits it", () => {
    const onCommit = vi.fn();
    render(<DraftTitleEditor value="" onCommit={onCommit} />);
    const input = startEditing();
    expect(document.activeElement).toBe(input);
    fireEvent.compositionStart(input);
    fireEvent.input(input, { target: { value: "工作" } });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(document.activeElement).toBe(input);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onCommit.mock.calls).toEqual([["工作"]]);
  });

  it("commits the trimmed name on blur in the compact header", () => {
    const onCommit = vi.fn();
    render(<DraftTitleEditor compact value="Existing" onCommit={onCommit} />);
    const input = startEditing();
    fireEvent.input(input, { target: { value: "  Team  " } });
    fireEvent.blur(input);
    expect(onCommit.mock.calls).toEqual([["Team"]]);
  });

  it("restores the latest title after Escape without committing the empty input", () => {
    const onCommit = vi.fn();
    const ui = render(<DraftTitleEditor value="Existing" onCommit={onCommit} />);
    const input = startEditing();
    fireEvent.input(input, { target: { value: "" } });
    ui.rerender(<DraftTitleEditor value="Restored" onCommit={onCommit} />);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("button").textContent).toBe("Restored");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(["Enter", "blur"])("clears an existing name on %s after a blank edit", (action) => {
    const onCommit = vi.fn();
    const ui = render(<DraftTitleEditor value="Existing" onCommit={onCommit} />);
    const input = startEditing();
    fireEvent.input(input, { target: { value: "  " } });
    if (action === "Enter") fireEvent.keyDown(input, { key: "Enter" });
    else fireEvent.blur(input);
    expect(onCommit.mock.calls).toEqual([[""]]);
    ui.rerender(<DraftTitleEditor value="" onCommit={onCommit} />);
    expect(screen.getByRole("button").textContent).toBe("New workspace");
  });

  it("discards an open edit when disabled and stays closed when editing becomes available", () => {
    const onCommit = vi.fn();
    const ui = render(<DraftTitleEditor value="Existing" onCommit={onCommit} />);
    fireEvent.input(startEditing(), { target: { value: "in progress" } });
    ui.rerender(<DraftTitleEditor value="Existing" onCommit={onCommit} disabled />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("textbox")).toBeNull();
    ui.rerender(<DraftTitleEditor value="Existing" onCommit={onCommit} />);
    expect(screen.getByRole("button").textContent).toBe("Existing");
    expect(onCommit).not.toHaveBeenCalled();
  });
});
