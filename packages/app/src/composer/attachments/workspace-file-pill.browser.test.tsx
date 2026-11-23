import React, { useCallback, useState } from "react";
import { cleanup, render } from "@testing-library/react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { WorkspaceFileComposerAttachment, WorkspaceFileSelection } from "@/attachments/types";
import { createWorkspaceFileAttachment } from "@/attachments/workspace-file";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { WorkspaceFileAttachmentPill } from "./workspace-file-pill";

vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  // The Vitest Unistyles double reports no breakpoint to hooks.
  useIsCompactFormFactor: () => window.innerWidth < 600,
}));

const fileName = "workspace-file.ts";
const path = `packages/app/src/composer/attachments/a-long-directory-name-without-spaces/${fileName}`;
const removeLabel = "Remove file attachment";
const trayStyle: ViewStyle = { position: "absolute", top: 160, right: 12, alignItems: "flex-end" };
const topTrayStyle: ViewStyle = { ...trayStyle, top: 0 };
const lineRange = { kind: "line_range", startLine: 17, endLine: 28 } as const;

function AttachmentTray({
  selection,
  active = true,
  nearTop = false,
}: {
  selection?: WorkspaceFileSelection;
  active?: boolean;
  nearTop?: boolean;
}) {
  const [attachment, setAttachment] = useState<WorkspaceFileComposerAttachment | null>(() =>
    createWorkspaceFileAttachment({ path, selection }),
  );
  const handleRemove = useCallback((index: number) => {
    if (index === 2) setAttachment(null);
  }, []);
  return (
    <View style={nearTop ? topTrayStyle : trayStyle}>
      <RetainedPanelActivity active={active}>
        <Pressable accessibilityRole="button" accessibilityLabel="Before attachment">
          <Text>Before</Text>
        </Pressable>
        {attachment && (
          <WorkspaceFileAttachmentPill
            attachment={attachment}
            index={2}
            disabled={false}
            onRemove={handleRemove}
            removeLabel={removeLabel}
            icon={null}
          />
        )}
        <Pressable accessibilityRole="button" accessibilityLabel="After attachment">
          <Text>After</Text>
        </Pressable>
      </RetainedPanelActivity>
    </View>
  );
}

function tooltipFitsViewport(element: Element): boolean {
  const range = document.createRange();
  range.selectNodeContents(element);
  const surface = element.getBoundingClientRect();
  const textRects = [...range.getClientRects()];
  return (
    textRects.length > 0 &&
    surface.left >= 8 &&
    surface.right <= window.innerWidth - 8 &&
    surface.top >= 8 &&
    surface.bottom <= window.innerHeight - 8 &&
    textRects.every(
      ({ left, right, top, bottom }) =>
        left >= surface.left &&
        right <= surface.right &&
        top >= surface.top &&
        bottom <= surface.bottom,
    )
  );
}

describe("composer workspace file attachment", () => {
  beforeEach(async () => {
    vi.stubGlobal("React", React);
    await page.viewport(320, 640);
  });

  afterEach(cleanup);

  it("shows the full relative path and line range on hover in a compact viewport", async () => {
    await page.viewport(260, 640);
    expect(window.innerWidth).toBe(260);
    render(<AttachmentTray selection={lineRange} />);
    const pill = page.getByTestId("composer-workspace-file-attachment-pill");
    const tooltip = page.getByRole("tooltip");
    await expect.element(tooltip).not.toBeInTheDocument();

    await pill.hover();

    await expect.element(tooltip).toHaveTextContent(`${path}:17-28`);
    await expect.poll(() => tooltipFitsViewport(tooltip.element())).toBe(true);
    await expect.element(tooltip).toBeVisible();
    await expect
      .poll(() => tooltip.element().getBoundingClientRect().bottom)
      .toBeLessThan(pill.element().getBoundingClientRect().top);

    await page.getByRole("button", { name: "After attachment" }).hover();
    await expect.element(tooltip).not.toBeInTheDocument();
    await page.getByRole("button", { name: removeLabel }).click();
    await expect.element(pill).not.toBeInTheDocument();
    await expect.element(tooltip).not.toBeInTheDocument();
  });

  it.each([
    { selection: undefined, expected: path },
    {
      selection: { kind: "line_range", startLine: 17, endLine: 17 } as const,
      expected: `${path}:17`,
    },
  ])(
    "shows $expected on keyboard focus and exposes it to assistive technology",
    async ({ selection, expected }) => {
      render(<AttachmentTray selection={selection} />);
      const before = page.getByRole("button", { name: "Before attachment" });
      const pill = page.getByRole("button", { name: expected, exact: true });
      const tooltip = page.getByRole("tooltip");

      await before.click();
      await userEvent.tab();

      await expect.element(pill).toHaveFocus();
      await expect.element(pill.getByText(fileName, { exact: true })).toBeVisible();
      await expect.poll(() => tooltip.element().textContent).toBe(expected);

      await userEvent.tab({ shift: true });
      await expect.element(tooltip).not.toBeInTheDocument();
    },
  );

  it("flips below the pill near the top edge and closes when its retained panel becomes inactive", async () => {
    const { rerender } = render(<AttachmentTray nearTop />);
    const pill = page.getByTestId("composer-workspace-file-attachment-pill");
    const tooltip = page.getByRole("tooltip");

    await pill.hover();
    await expect.poll(() => tooltipFitsViewport(tooltip.element())).toBe(true);
    await expect
      .poll(() => tooltip.element().getBoundingClientRect().top)
      .toBeGreaterThan(pill.element().getBoundingClientRect().bottom);

    rerender(<AttachmentTray nearTop active={false} />);
    await expect.element(tooltip).not.toBeInTheDocument();
    rerender(<AttachmentTray nearTop />);
    await expect.element(tooltip).not.toBeInTheDocument();
  });
});
