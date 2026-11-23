import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  AssistantFileLinkResolverProvider,
  type AssistantFileLinkResolverProviderProps,
} from "@/assistant-file-links";
import { createAssistantSelectionClipboardContent } from "@/assistant-selection-copy/content.web";
import { ForgeShorthandProvider } from "@/git/forge-shorthand";
import { i18n } from "@/i18n/i18next";
import { openExternalUrl } from "@/utils/open-external-url";
import { MarkdownRenderer, type MarkdownRendererProps } from "./renderer";

vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  // The test theme runtime does not provide a breakpoint.
  useIsCompactFormFactor: () => window.innerWidth < 600,
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => {}),
}));

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.mocked(openExternalUrl).mockClear();
  await i18n.changeLanguage("en");
  await page.viewport(900, 640);
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  vi.unstubAllGlobals();
});

function renderMarkdown(
  props: MarkdownRendererProps,
  fileLinks: Omit<AssistantFileLinkResolverProviderProps, "children"> = {},
) {
  const queryClient = new QueryClient();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AssistantFileLinkResolverProvider serverId="test-host" workspaceRoot="/repo" {...fileLinks}>
        <ForgeShorthandProvider
          forge="github"
          remoteUrl="https://github.com/o/r.git"
          forgeWeb={null}
        >
          <button type="button">Before markdown</button>
          <div data-testid="assistant-message">
            <MarkdownRenderer {...props} />
          </div>
          <button type="button">After markdown</button>
        </ForgeShorthandProvider>
      </AssistantFileLinkResolverProvider>
    </QueryClientProvider>,
  );
  return result;
}

async function expectTooltip(name: string, text: string) {
  const anchor = page.getByRole("link", { name, exact: true });
  await expect.element(anchor).not.toHaveAttribute("title");
  await anchor.hover();
  const tooltip = page.getByRole("tooltip");
  await expect.poll(() => document.querySelector('[role="tooltip"]')?.textContent).toBe(text);
  await expect.element(tooltip).toBeVisible();
  expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
  return anchor;
}

it("shows the destination for authored, parser and recognized URLs in a compact viewport", async () => {
  await page.viewport(320, 640);
  const callback = vi.fn();
  const title = "A different title written by the author";
  const longUrl =
    "https://example.com/a-long-url-without-spaces-that-extends-past-the-width-of-the-browser-window";
  renderMarkdown({
    text: [
      "[Guide](" + longUrl + ' "' + title + '")',
      '[Same title](https://example.com/same "https://example.com/same")',
      "http://example.com/parser",
      "www.example.com",
      "https://[::1]:8059/paseo",
      "#12",
      "[Local](/repo/src/index.ts#L12-L18)",
    ].join("\n\n"),
    onLinkPress: callback,
  });
  const authored = await expectTooltip("Guide", longUrl + "\n" + title);
  await expect.element(authored).not.toHaveAttribute("data-paseo-markdown-recognized-link");
  await expect
    .poll(() => {
      const bounds = page.getByRole("tooltip").element().getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= window.innerWidth;
    })
    .toBe(true);
  await authored.click();
  expect(callback).toHaveBeenCalledWith(longUrl);

  await expectTooltip("Same title", "https://example.com/same");
  await expectTooltip("http://example.com/parser", "http://example.com/parser");
  await expectTooltip("www.example.com", "http://www.example.com");
  const recognized = await expectTooltip("https://[::1]:8059/paseo", "https://[::1]:8059/paseo");
  await expect.element(recognized).toHaveAttribute("data-paseo-markdown-recognized-link", "true");
  const forge = await expectTooltip("#12", "https://github.com/o/r/issues/12");
  await expect.element(forge).toHaveAttribute("href", "https://github.com/o/r/issues/12");
  await expectTooltip("Local", "src/index.ts:12-18");
  await page.getByRole("button", { name: "After markdown" }).hover();
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
});

it("exposes only validated HTTPS destinations for external Markdown", async () => {
  const callback = vi.fn();
  const getDirectorySuggestions = vi.fn(async () => ({ entries: [], error: null }));
  const { getByTestId } = renderMarkdown(
    {
      external: true,
      onLinkPress: callback,
      text: [
        '[Safe](https://example.com/docs "Public docs")',
        "https://[::1]:8059/paseo",
        "http://example.com/unsafe",
        "www.example.com",
        "a@example.com",
        "[relative](./doc.md) #12",
      ].join("\n\n"),
    },
    { client: { getDirectorySuggestions } },
  );
  const anchor = await expectTooltip("Safe", "https://example.com/docs\nPublic docs");
  await expect.element(anchor).toHaveAttribute("target", "_blank");
  await expect.element(anchor).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await anchor.click();
  const recognized = await expectTooltip("https://[::1]:8059/paseo", "https://[::1]:8059/paseo");
  await recognized.click();

  const message = getByTestId("assistant-message");
  expect(Array.from(message.querySelectorAll("a"), (link) => link.getAttribute("href"))).toEqual([
    "https://example.com/docs",
    "https://[::1]:8059/paseo",
  ]);
  for (const text of [
    "http://example.com/unsafe",
    "www.example.com",
    "a@example.com",
    "relative #12",
  ]) {
    expect(message.textContent).toContain(text);
  }
  expect(vi.mocked(openExternalUrl).mock.calls).toEqual([
    ["https://example.com/docs"],
    ["https://[::1]:8059/paseo"],
  ]);
  expect(callback).not.toHaveBeenCalled();
  expect(getDirectorySuggestions).not.toHaveBeenCalled();
});

it("resolves an authored relative file on keyboard focus and opens the displayed first match", async () => {
  await page.viewport(320, 640);
  type Suggestions = Awaited<
    ReturnType<
      NonNullable<AssistantFileLinkResolverProviderProps["client"]>["getDirectorySuggestions"]
    >
  >;
  const lookup = Promise.withResolvers<Suggestions>();
  const getDirectorySuggestions = vi.fn(() => lookup.promise);
  const onOpenWorkspaceFile = vi.fn();
  renderMarkdown(
    { text: '[File](schema/x.md#L5-L8 "Schema overview")' },
    { client: { getDirectorySuggestions }, onOpenWorkspaceFile },
  );
  const link = page.getByRole("link", { name: "File" });
  await expect.element(link).toBeInTheDocument();
  expect(getDirectorySuggestions).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Before markdown" }).click();
  await userEvent.tab();
  await expect.element(link).toHaveFocus();
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toHaveTextContent("schema/x.md#L5-L8 Looking up… Schema overview");
  lookup.resolve({
    entries: [
      { path: "repo-z/schema/x.md", kind: "file" },
      { path: "repo-a/schema/x.md", kind: "file" },
    ],
    error: null,
  });
  await expect
    .element(tooltip)
    .toHaveTextContent(
      "repo-z/schema/x.md:5-8 Multiple matches. Opens this path by default. Schema overview",
    );
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => onOpenWorkspaceFile.mock.calls)
    .toEqual([
      [
        expect.objectContaining({ path: "/repo/repo-z/schema/x.md", lineStart: 5, lineEnd: 8 }),
        "preferred",
      ],
    ]);
  expect(getDirectorySuggestions).toHaveBeenCalledExactlyOnceWith({
    query: "schema/x.md",
    cwd: "/repo",
    includeFiles: true,
    includeDirectories: false,
    matchMode: "suffix",
    limit: 2,
  });
});

it("uses the same decoded file path and line range for hover and click", async () => {
  const getDirectorySuggestions = vi.fn(async ({ query }: { query: string }) => ({
    entries: [{ path: query, kind: "file" as const }],
    error: null,
  }));
  const onOpenWorkspaceFile = vi.fn();
  renderMarkdown(
    { text: "[Escaped](docs/a\\(b\\)-my%2520file.md#L4-L7) and `docs/my%20file.md:6-9`" },
    { client: { getDirectorySuggestions }, onOpenWorkspaceFile },
  );
  const authored = await expectTooltip("Escaped", "docs/a(b)-my%20file.md:4-7");
  await authored.click();
  const inferred = await expectTooltip("docs/my%20file.md:6-9", "docs/my%20file.md:6-9");
  await expect.element(inferred).toHaveAttribute("href", "docs/my%20file.md:6-9");
  await expect.element(inferred).toHaveAttribute("data-paseo-markdown-recognized-link", "true");
  await inferred.click();
  await expect
    .poll(() => onOpenWorkspaceFile.mock.calls)
    .toEqual([
      [
        expect.objectContaining({ path: "/repo/docs/a(b)-my%20file.md", lineStart: 4, lineEnd: 7 }),
        "preferred",
      ],
      [
        expect.objectContaining({ path: "/repo/docs/my%20file.md", lineStart: 6, lineEnd: 9 }),
        "preferred",
      ],
    ]);
  expect(getDirectorySuggestions.mock.calls.map(([input]) => input.query)).toEqual([
    "docs/a(b)-my%20file.md",
    "docs/my%20file.md",
  ]);
});

it("copies authored and recognized links without including the open tooltip", async () => {
  const { getByTestId } = renderMarkdown({
    text: '[Guide](https://example.com/doc "Authored description") http://example.com/parser `https://devbox/paseo` #12 src/index.ts',
  });
  await expectTooltip("Guide", "https://example.com/doc\nAuthored description");
  const range = document.createRange();
  range.selectNodeContents(getByTestId("assistant-message"));
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const content = createAssistantSelectionClipboardContent(selection);
  expect(content?.plainText).toBe(
    "[Guide](https://example.com/doc) [http://example.com/parser](http://example.com/parser) `https://devbox/paseo` #12 src/index.ts",
  );
  expect(content?.html).toContain(
    '<a href="https://devbox/paseo"><code>https://devbox/paseo</code></a>',
  );
  expect(content?.html).toContain('<a href="https://github.com/o/r/issues/12">#12</a>');
  expect(content?.html).not.toContain("Authored description");
  expect(content?.html).not.toContain('href="src/index.ts"');
});
