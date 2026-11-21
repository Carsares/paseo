import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import type {
  PluginSelectionButtonBehavior,
  PluginTimelineSelection,
} from "@getpaseo/plugin/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { createMarkdownParser } from "@/utils/markdown-parser";
import { ComposerQuoteProvider } from "./composer-quote";
import {
  createAssistantSelectionClipboardContent,
  createAssistantSelectionMarkdown,
} from "./content.web";

vi.mock("lucide-react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("lucide-react-native")>()),
  AlertCircle: () => null,
  ChevronUp: () => null,
  Crown: () => null,
  TextQuote: () => null,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({}),
  useHostRuntimeIsConnected: () => true,
  isHostRuntimeConnected: () => true,
  useHosts: () => [{ serverId: "test-host", label: "Test host" }],
  getHostRuntimeStore: () => ({
    getHosts: () => [],
    subscribeAll: () => () => {},
    subscribeHostList: () => () => {},
  }),
}));

const fixture = `
  <div data-testid="assistant-message">
    <div data-paseo-markdown-tag="p">Prefix <span data-paseo-markdown-tag="strong">bold text</span> and <span data-paseo-markdown-tag="code">inline code</span> suffix.</div>
    <div data-paseo-markdown-tag="ul">
      <div data-paseo-markdown-tag="li"><span data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">•</span><div><span>First bullet text</span></div></div>
      <div data-paseo-markdown-tag="li"><span data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">•</span><div><span>Second bullet text</span></div></div>
    </div>
    <div data-paseo-markdown-tag="pre" data-paseo-markdown-language="ts"><span data-paseo-markdown-tag="code">const answer = true;</span></div>
  </div>
`;

function mountFixture(): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = fixture;
  document.body.append(host);
  const message = host.querySelector<HTMLElement>('[data-testid="assistant-message"]');
  if (!message) {
    throw new Error("Expected assistant message fixture");
  }
  return message;
}

function fixtureElement<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
  index = 0,
): T {
  const element = root.querySelectorAll<T>(selector).item(index);
  if (!element) {
    throw new Error(`Expected fixture element ${selector} at index ${index}`);
  }
  return element;
}

function textNode(element: Element): Text {
  const node = element.firstChild;
  if (!(node instanceof Text)) {
    throw new Error("Expected text node");
  }
  return node;
}

function selectText(element: Element, start: number, end: number): Selection {
  const node = textNode(element);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Expected browser selection");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function selectRange(
  startElement: Element,
  startOffset: number,
  endElement: Element,
  endOffset: number,
): Selection {
  const range = document.createRange();
  range.setStart(textNode(startElement), startOffset);
  range.setEnd(textNode(endElement), endOffset);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Expected browser selection");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function selectNodeContents(element: Element): Selection {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Expected browser selection");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

interface TranscriptMessage {
  messageId: string;
  blocks: string[];
}

/**
 * The web transcript's shape: a scroll container holding one row per Markdown block,
 * each row carrying its message id and wrapping its own assistant message element.
 */
function mountTranscript(messages: TranscriptMessage[]): HTMLElement {
  const transcript = document.createElement("div");
  transcript.setAttribute("data-testid", "agent-chat-scroll");
  for (const { messageId, blocks } of messages) {
    for (const [index, text] of blocks.entries()) {
      const row = document.createElement("div");
      row.setAttribute("data-history-row-id", `${messageId}:block:${index}`);
      row.setAttribute("data-message-id", messageId);
      row.innerHTML = `<div data-testid="assistant-message"><div data-paseo-markdown-tag="p">${text}</div></div>`;
      transcript.append(row);
    }
  }
  document.body.append(transcript);
  return transcript;
}

function copiedMarkdown(selection: Selection): string | null {
  return createAssistantSelectionClipboardContent(selection)?.plainText ?? null;
}

afterEach(async () => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  if (i18n.language !== "en") await i18n.changeLanguage("en");
});

describe("assistant selection quote", () => {
  let AssistantSelectionQuote: typeof import("./quote.web").AssistantSelectionQuote;
  beforeAll(async () => {
    // Load after Vitest installs the icon mock so Vite's dependency scan skips the unmocked export.
    const quoteModule = "./quote.web.tsx";
    ({ AssistantSelectionQuote } = await import(/* @vite-ignore */ quoteModule));
  });

  function mountQuoteStream(
    messages: TranscriptMessage[] = [{ messageId: "reply", blocks: ["Selected passage."] }],
  ) {
    const viewport = mountTranscript(messages);
    const stream = document.createElement("div");
    stream.style.display = "contents";
    viewport.replaceWith(stream);
    stream.append(viewport);
    viewport.style.cssText = "height: 120px; overflow-y: auto";
    const spacer = document.createElement("div");
    spacer.style.height = "400px";
    viewport.append(spacer);
    const message = fixtureElement(viewport, '[data-paseo-markdown-tag="p"]');
    return { streamRef: { current: stream }, viewport, message };
  }

  function expectSelectionDismissed() {
    expect(window.getSelection()?.rangeCount).toBe(0);
    expect(screen.queryByTestId("assistant-selection-quote")).toBeNull();
    expect(screen.queryByTestId("assistant-selection-context-menu")).toBeNull();
  }

  async function mountPluginSelection(
    behavior: PluginSelectionButtonBehavior,
    addQuoteAttachment?: (quote: string) => void,
  ) {
    const surfaceModule = "./surface.web.tsx";
    const [
      { pluginButtonStore },
      { PluginTranslationRuntime },
      { QueryClient },
      { ToastProvider },
      { AssistantSelectionCopySurface },
    ] = await Promise.all([
      import("@/plugins/buttons/store"),
      import("@getpaseo/plugin/client/host"),
      import("@tanstack/react-query"),
      import("@/contexts/toast-context"),
      import(/* @vite-ignore */ surfaceModule) as Promise<typeof import("./surface.web")>,
    ]);
    const pluginI18n = new PluginTranslationRuntime({
      getLocale: () => "en",
      subscribe: () => () => {},
    });
    const lifetime = new AbortController();
    const registration = pluginButtonStore.addSelectionButton(
      {
        lifetime,
        id: "test-plugin",
        serverId: "test-host",
        queryClient: new QueryClient(),
        i18n: pluginI18n,
        paseo: { workspaces: {}, agents: {}, terminals: {}, projects: {} },
      } as import("@/plugins/types").InstalledPlugin,
      {
        id: "review",
        workspaceId: "test-workspace",
        button: { title: "Plugin review", icon: () => null, behavior },
      },
    );
    const { viewport } = mountQuoteStream([
      {
        messageId: "reply",
        blocks: ['<span data-paseo-markdown-tag="strong">Selected</span>'],
      },
      { messageId: "other", blocks: ["Other passage."] },
    ]);
    render(
      createElement(
        ToastProvider,
        null,
        createElement(
          KeyboardActionDispatcherProvider,
          null,
          createElement(
            ComposerQuoteProvider,
            { target: addQuoteAttachment ? { addQuoteAttachment } : null },
            createElement(
              AssistantSelectionCopySurface,
              {
                serverId: "test-host",
                workspaceId: "test-workspace",
                agentId: "test-agent",
              } as import("./surface").AssistantSelectionCopySurfaceProps,
              createElement("div", {
                dangerouslySetInnerHTML: { __html: viewport.outerHTML },
              }),
            ),
          ),
        ),
      ),
    );
    viewport.parentElement?.remove();
    const transcript = screen.getByTestId("agent-chat-scroll");
    return {
      original: fixtureElement(transcript, '[data-paseo-markdown-tag="p"]'),
      other: fixtureElement(transcript, '[data-paseo-markdown-tag="p"]', 1),
      remove() {
        registration.remove();
        pluginI18n.dispose();
        lifetime.abort();
      },
    };
  }

  const pluginSnapshot: PluginTimelineSelection = {
    text: "Selected",
    markdown: "**Selected**",
    messageId: "reply",
    workspaceId: "test-workspace",
    agentId: "test-agent",
  };

  const pluginMenu = (onPress: (selection: PluginTimelineSelection) => void) =>
    ({
      kind: "menu",
      items: [
        {
          kind: "item",
          id: "more",
          title: "More review actions",
          behavior: {
            kind: "menu",
            items: [
              {
                kind: "item",
                id: "run",
                title: "Review passage",
                behavior: { kind: "action", onPress },
              },
            ],
          },
        },
      ],
    }) satisfies PluginSelectionButtonBehavior;

  it("keeps plugin-only floating menus anchored to the original selection through DOM and selection changes", async () => {
    const onPress = vi.fn();
    const { original, other, remove } = await mountPluginSelection(pluginMenu(onPress));
    try {
      selectNodeContents(original);
      const toolbar = await screen.findByTestId("assistant-selection-quote");
      fireEvent.click(await screen.findByRole("button", { name: "Plugin review" }));
      const trigger = await screen.findByText("More review actions");
      const position = toolbar.getBoundingClientRect();
      act(() => {
        selectText(other, 0, 5);
        original.remove();
        fireEvent(document, new Event("selectionchange"));
      });
      await expect.element(page.getByText("More review actions")).toBeVisible();
      expect(toolbar.getBoundingClientRect().x).toBe(position.x);
      expect(toolbar.getBoundingClientRect().y).toBe(position.y);
      fireEvent.click(trigger);
      await userEvent.click(page.getByText("Review passage"));
      expect(onPress).toHaveBeenCalledExactlyOnceWith(pluginSnapshot);
      expectSelectionDismissed();
    } finally {
      act(remove);
    }
  });

  it("uses the captured selection for a plugin-only right-click submenu", async () => {
    const previous = document.createElement("button");
    const destination = document.createElement("button");
    document.body.append(previous, destination);
    const onPress = vi.fn(() => {
      expectSelectionDismissed();
      expect(document.activeElement).toBe(previous);
      destination.focus();
    });
    const { original, other, remove } = await mountPluginSelection(pluginMenu(onPress));
    try {
      previous.focus();
      selectNodeContents(original);
      fireEvent.contextMenu(original, { clientX: 15, clientY: 15 });
      fireEvent.click(await screen.findByText("Plugin review"));
      fireEvent.click(await screen.findByText("More review actions"));
      selectText(other, 0, 5);
      await userEvent.click(page.getByText("Review passage"));
      expect(onPress).toHaveBeenCalledExactlyOnceWith(pluginSnapshot);
      expect(document.activeElement).toBe(destination);
      expectSelectionDismissed();
    } finally {
      act(remove);
    }
  });

  it("lets an open plugin menu handle Enter and Escape before the built-in quote shortcut", async () => {
    const onPress = vi.fn();
    const onQuote = vi.fn();
    const previous = document.createElement("button");
    document.body.append(previous);
    const { original, remove } = await mountPluginSelection(
      {
        kind: "menu",
        items: [
          {
            kind: "item",
            id: "run",
            title: "Review passage",
            behavior: { kind: "action", onPress },
          },
        ],
      },
      onQuote,
    );
    const open = async () => {
      previous.focus();
      selectNodeContents(original);
      await screen.findByText(i18n.t("agentStream.quote.action"));
      fireEvent.click(await screen.findByRole("button", { name: "Plugin review" }));
      await expect.element(page.getByRole("menuitem", { name: "Review passage" })).toHaveFocus();
    };
    try {
      await open();
      await userEvent.keyboard("{Enter}");
      expect(onQuote).not.toHaveBeenCalled();
      expect(onPress).toHaveBeenCalledExactlyOnceWith(pluginSnapshot);

      await open();
      await userEvent.keyboard("{Escape}");
      expect(onQuote).not.toHaveBeenCalled();
      expect(onPress).toHaveBeenCalledTimes(1);
      expectSelectionDismissed();
      expect(document.activeElement).toBe(previous);
    } finally {
      act(remove);
    }
  });

  it("passes a frozen selection to a plugin popover and clears it when the content closes", async () => {
    const { original, other, remove } = await mountPluginSelection({
      kind: "popover",
      Content({ selection, close }) {
        return createElement("button", { onClick: close }, selection.markdown);
      },
    });
    try {
      selectNodeContents(original);
      await screen.findByTestId("assistant-selection-quote");
      fireEvent.click(await screen.findByRole("button", { name: "Plugin review" }));
      selectText(other, 0, 5);
      await userEvent.click(page.getByRole("button", { name: "**Selected**" }));
      expectSelectionDismissed();
    } finally {
      act(remove);
    }
  });

  it("delivers the frozen selection to a right-click popover and restores focus on close", async () => {
    const previous = document.createElement("button");
    document.body.append(previous);
    const { original, other, remove } = await mountPluginSelection({
      kind: "popover",
      Content({ selection, close }) {
        return createElement("button", { onClick: close }, selection.markdown);
      },
    });
    try {
      previous.focus();
      selectNodeContents(original);
      fireEvent.contextMenu(original, { clientX: 15, clientY: 15 });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Plugin review" }));
      selectText(other, 0, 5);
      await userEvent.click(page.getByRole("button", { name: "**Selected**" }));
      expect(screen.queryByTestId("assistant-selection-context-menu")).toBeNull();
      expect(document.activeElement).toBe(previous);
    } finally {
      act(remove);
    }
  });

  it("shows action errors and lets the user retry after a pending plugin action rejects", async () => {
    const { promise, reject } = Promise.withResolvers<void>();
    const onPress = vi
      .fn<(selection: PluginTimelineSelection) => void | Promise<void>>()
      .mockReturnValueOnce(promise)
      .mockImplementationOnce(() => {
        throw new Error("Review unavailable");
      });
    const { original, remove } = await mountPluginSelection({ kind: "action", onPress });
    try {
      selectNodeContents(original);
      fireEvent.click(await screen.findByRole("button", { name: "Plugin review" }));
      expectSelectionDismissed();
      selectNodeContents(original);
      const retry = await screen.findByRole("button", { name: "Plugin review" });
      expect(retry.getAttribute("aria-disabled")).toBe("true");
      await act(async () => reject(new Error("Review timed out")));
      await expect.element(page.getByText("Review timed out")).toBeVisible();
      expect(retry.getAttribute("aria-disabled")).not.toBe("true");
      fireEvent.click(retry);
      await expect.element(page.getByText("Review unavailable")).toBeVisible();
      expect(onPress.mock.calls).toEqual([[pluginSnapshot], [pluginSnapshot]]);
    } finally {
      act(remove);
    }
  });

  it("settles a cancelled touch selection and hides offscreen or unmounted anchors", async () => {
    const { streamRef, viewport, message } = mountQuoteStream();
    const onQuote = vi.fn();
    render(createElement(AssistantSelectionQuote, { streamRef, onQuote }));
    fireEvent.pointerDown(message, { pointerType: "touch", button: 0 });
    selectText(message, 0, 8);
    fireEvent.pointerCancel(message, { pointerType: "touch" });
    const pill = await screen.findByTestId("assistant-selection-quote");

    const scroll = (top: number) => {
      viewport.scrollTop = top;
      fireEvent.scroll(viewport);
    };
    scroll(200);
    await expect.poll(() => screen.queryByTestId("assistant-selection-quote")).toBeNull();
    scroll(0);
    const returnedPill = await screen.findByTestId("assistant-selection-quote");
    expect(pill.isConnected).toBe(false);
    fireEvent.click(returnedPill.querySelector("button, [role='button']")!);
    expect(onQuote).toHaveBeenCalledExactlyOnceWith({ quote: "Selected" });
    expect(screen.queryByTestId("assistant-selection-quote")).toBeNull();
    expect(screen.queryByTestId("assistant-selection-quote-note")).toBeNull();

    fireEvent.pointerDown(message, { pointerType: "touch", button: 0 });
    selectText(message, 0, 8);
    fireEvent.pointerCancel(message, { pointerType: "touch" });
    await screen.findByTestId("assistant-selection-quote");
    message.remove();
    await expect.poll(() => screen.queryByTestId("assistant-selection-quote")).toBeNull();
  });

  it("quotes directly from the context menu and hides quote actions if the quote target disappears", async () => {
    const { streamRef, message } = mountQuoteStream();
    const onQuote = vi.fn();
    const onSpawnSubagentFromSelection = vi.fn();
    const quote = (handler?: typeof onQuote) =>
      createElement(AssistantSelectionQuote, {
        streamRef,
        onQuote: handler,
        onSpawnSubagentFromSelection,
      });
    const { rerender } = render(quote(onQuote));
    selectText(message, 0, 8);
    const contextMenu = () => fireEvent.contextMenu(message, { clientX: 15, clientY: 15 });
    contextMenu();
    fireEvent.click(await screen.findByTestId("assistant-selection-context-menu-quote"));
    expect(onQuote).toHaveBeenCalledExactlyOnceWith({ quote: "Selected" });
    expect(screen.queryByTestId("assistant-selection-quote-note")).toBeNull();

    rerender(quote());
    selectText(message, 0, 8);
    contextMenu();
    await screen.findByTestId("assistant-selection-context-menu-subagent");
    expect(screen.queryByTestId("assistant-selection-context-menu-quote")).toBeNull();
    expect(onQuote).toHaveBeenCalledTimes(1);
  });

  it.each([
    { language: "en", mode: undefined, label: "New subagent" },
    { language: "en", mode: "sibling", label: "New sibling subagent" },
    { language: "zh-CN", mode: "child", label: "新建子会话" },
    { language: "zh-CN", mode: "sibling", label: "新建同级会话" },
  ] as const)(
    "spawns from either action with the $language label $label",
    async ({ language, mode, label }) => {
      const { streamRef, message } = mountQuoteStream();
      const onSpawnSubagentFromSelection = vi.fn();
      await i18n.changeLanguage(language);
      render(
        createElement(AssistantSelectionQuote, {
          streamRef,
          subagentSpawnMode: mode,
          onSpawnSubagentFromSelection,
        }),
      );

      selectText(message, 0, 8);
      const pillAction = await screen.findByTestId("assistant-selection-spawn-subagent");
      expect(pillAction.textContent).toBe(label);
      fireEvent.click(pillAction);
      expect(onSpawnSubagentFromSelection).toHaveBeenCalledExactlyOnceWith("Selected", {
        messageRowId: "reply",
      });
      expectSelectionDismissed();

      selectText(message, 0, 8);
      fireEvent.contextMenu(message, { clientX: 15, clientY: 15 });
      const menuAction = await screen.findByTestId("assistant-selection-context-menu-subagent");
      expect(menuAction.textContent).toBe(label);
      fireEvent.click(menuAction);
      expect(onSpawnSubagentFromSelection).toHaveBeenCalledTimes(2);
      expect(onSpawnSubagentFromSelection).toHaveBeenNthCalledWith(2, "Selected", {
        messageRowId: "reply",
      });
      expectSelectionDismissed();
    },
  );

  it("spawns from the pill or menu across multiple block rows of one message", async () => {
    const { streamRef, viewport, message } = mountQuoteStream([
      { messageId: "reply", blocks: ["Selected", "passage."] },
    ]);
    const lastBlock = fixtureElement(viewport, '[data-paseo-markdown-tag="p"]', 1);
    const onSpawnSubagentFromSelection = vi.fn();
    render(createElement(AssistantSelectionQuote, { streamRef, onSpawnSubagentFromSelection }));

    selectRange(message, 0, lastBlock, 7);
    fireEvent.click(await screen.findByTestId("assistant-selection-spawn-subagent"));
    expect(onSpawnSubagentFromSelection).toHaveBeenCalledExactlyOnceWith("Selected\n\npassage", {
      messageRowId: "reply",
    });
    expectSelectionDismissed();

    selectRange(message, 0, lastBlock, 7);
    fireEvent.contextMenu(lastBlock, { clientX: 15, clientY: 30 });
    fireEvent.click(await screen.findByTestId("assistant-selection-context-menu-subagent"));
    expect(onSpawnSubagentFromSelection).toHaveBeenCalledTimes(2);
    expect(onSpawnSubagentFromSelection).toHaveBeenNthCalledWith(2, "Selected\n\npassage", {
      messageRowId: "reply",
    });
    expectSelectionDismissed();
  });

  it("spawns with the original selection after the context menu restores focus", async () => {
    const { streamRef, viewport, message } = mountQuoteStream([
      { messageId: "reply", blocks: ["Selected passage."] },
      { messageId: "other-reply", blocks: ["Other passage."] },
    ]);
    const otherMessage = fixtureElement(viewport, '[data-paseo-markdown-tag="p"]', 1);
    const originalPane = document.createElement("button");
    const newPane = document.createElement("button");
    document.body.append(originalPane, newPane);
    originalPane.focus();
    const onSpawnSubagentFromSelection = vi.fn(() => {
      expectSelectionDismissed();
      expect(document.activeElement).toBe(originalPane);
      newPane.focus();
    });
    render(createElement(AssistantSelectionQuote, { streamRef, onSpawnSubagentFromSelection }));

    selectText(message, 0, 8);
    fireEvent.contextMenu(message, { clientX: 15, clientY: 15 });
    const menuAction = page.getByTestId("assistant-selection-context-menu-subagent");
    await expect.element(menuAction).toHaveFocus();
    selectText(otherMessage, 0, 5);
    await userEvent.click(menuAction);

    expect(onSpawnSubagentFromSelection).toHaveBeenCalledExactlyOnceWith("Selected", {
      messageRowId: "reply",
    });
    expect(document.activeElement).toBe(newPane);
  });

  it("keeps the floating selection shortcut on the primary quote action", async () => {
    const { streamRef, message } = mountQuoteStream();
    const onQuote = vi.fn();
    const onSpawnSubagentFromSelection = vi.fn();
    render(
      createElement(AssistantSelectionQuote, { streamRef, onQuote, onSpawnSubagentFromSelection }),
    );

    selectText(message, 0, 8);
    await screen.findByTestId("assistant-selection-spawn-subagent");
    await userEvent.keyboard("{Enter}");

    expect(onQuote).toHaveBeenCalledExactlyOnceWith({ quote: "Selected" });
    expect(onSpawnSubagentFromSelection).not.toHaveBeenCalled();
    expectSelectionDismissed();
  });

  it.each(["callback removal", "unmount"] as const)(
    "cancels the pending menu action on %s",
    async (change) => {
      const { streamRef, message } = mountQuoteStream();
      const onSpawnSubagentFromSelection = vi.fn();
      const { rerender, unmount } = render(
        createElement(AssistantSelectionQuote, { streamRef, onSpawnSubagentFromSelection }),
      );

      selectText(message, 0, 8);
      fireEvent.contextMenu(message, { clientX: 15, clientY: 15 });
      const menuAction = await screen.findByTestId("assistant-selection-context-menu-subagent");

      // Apply the availability change in the same update that closes the menu.
      act(() => {
        fireEvent.click(menuAction);
        if (change === "unmount") {
          unmount();
        } else {
          rerender(createElement(AssistantSelectionQuote, { streamRef }));
        }
      });

      expect(onSpawnSubagentFromSelection).not.toHaveBeenCalled();
      expectSelectionDismissed();
    },
  );

  it("keeps spawn callbacks single-argument when the message has no row id", async () => {
    const message = mountFixture();
    const streamRef = { current: message };
    const onSpawnSubagentFromSelection = vi.fn();
    render(createElement(AssistantSelectionQuote, { streamRef, onSpawnSubagentFromSelection }));

    const paragraph = fixtureElement(message, '[data-paseo-markdown-tag="p"]');
    selectText(paragraph, 0, 6);
    fireEvent.click(await screen.findByTestId("assistant-selection-spawn-subagent"));
    expect(onSpawnSubagentFromSelection).toHaveBeenCalledExactlyOnceWith("Prefix");

    selectText(paragraph, 0, 6);
    fireEvent.contextMenu(paragraph, { clientX: 15, clientY: 15 });
    fireEvent.click(await screen.findByTestId("assistant-selection-context-menu-subagent"));
    expect(onSpawnSubagentFromSelection).toHaveBeenCalledTimes(2);
    expect(onSpawnSubagentFromSelection).toHaveBeenNthCalledWith(2, "Prefix");
  });
});

describe("assistant selection copy ranges", () => {
  it("does not handle absent, collapsed, or non-assistant selections", () => {
    expect(createAssistantSelectionClipboardContent(null)).toBeNull();

    const message = mountFixture();
    const strong = fixtureElement(message, '[data-paseo-markdown-tag="strong"]');
    expect(copiedMarkdown(selectText(strong, 2, 2))).toBeNull();

    const outside = document.createElement("span");
    outside.textContent = "outside";
    document.body.append(outside);
    expect(copiedMarkdown(selectText(outside, 0, 7))).toBeNull();
  });

  it("copies a selection that runs across the block rows of one message", () => {
    const transcript = mountTranscript([
      { messageId: "message-1", blocks: ["First paragraph.", "Second paragraph."] },
    ]);
    const blocks = transcript.querySelectorAll('[data-paseo-markdown-tag="p"]');
    expect(copiedMarkdown(selectRange(blocks[0]!, 6, blocks[1]!, 6))).toBe("paragraph.\n\nSecond");
  });

  // Chrome anchors a drag that starts in the gap below an image at the start of the
  // image's rendered internals: the background-image layer, ahead of the hidden `img`.
  // Only the text after it is highlighted.
  it("leaves out an image when the selection starts in the gap below it", () => {
    const transcript = mountTranscript([
      {
        messageId: "message-1",
        blocks: [
          "Before the image.",
          '<div data-paseo-markdown-tag="img" data-paseo-markdown-src="https://example.test/chart.png" data-paseo-markdown-alt="chart"><div><div style="background-image: url(blob:https://example.test/preview)"></div><img src="blob:https://example.test/preview" alt=""></div></div>',
          "After the image.",
        ],
      },
    ]);
    const frame = fixtureElement(transcript, '[data-paseo-markdown-tag="img"]');
    const range = document.createRange();
    range.setStart(frame.firstElementChild!.firstElementChild!, 0);
    range.setEnd(textNode(fixtureElement(transcript, '[data-paseo-markdown-tag="p"]', 2)), 9);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(copiedMarkdown(selection)).toBe("After the");
  });

  it("keeps a failed image when the selection starts in its error text", () => {
    const transcript = mountTranscript([
      {
        messageId: "message-1",
        blocks: [
          '<div data-paseo-markdown-tag="img" data-paseo-markdown-src="https://example.test/chart.png" data-paseo-markdown-alt="chart"><div>Image failed to load</div></div>',
          "After the image.",
        ],
      },
    ]);
    const frame = fixtureElement(transcript, '[data-paseo-markdown-tag="img"]');
    const selection = selectRange(
      frame.firstElementChild!,
      6,
      fixtureElement(transcript, '[data-paseo-markdown-tag="p"]', 1),
      9,
    );

    expect(copiedMarkdown(selection)).toBe("![chart](https://example.test/chart.png)\n\nAfter the");
  });

  it("does not replace the browser clipboard for a selection reaching a second message", () => {
    const transcript = mountTranscript([
      { messageId: "message-1", blocks: ["First paragraph.", "Second paragraph."] },
      { messageId: "message-2", blocks: ["Reply paragraph."] },
    ]);
    const blocks = transcript.querySelectorAll('[data-paseo-markdown-tag="p"]');
    expect(copiedMarkdown(selectRange(blocks[1]!, 0, blocks[2]!, 5))).toBeNull();
  });

  // A retained inactive panel renders the same agent, so the same message id can exist
  // twice in the document. A group is only ever read out of one transcript, and rows
  // that belong to no transcript are not a group at all.
  it("does not assemble a message group from rows outside a transcript", () => {
    const transcript = mountTranscript([
      { messageId: "message-1", blocks: ["First paragraph.", "Second paragraph."] },
    ]);
    document.body.append(...transcript.children);
    transcript.remove();
    const blocks = document.querySelectorAll('[data-paseo-markdown-tag="p"]');
    expect(copiedMarkdown(selectRange(blocks[0]!, 0, blocks[1]!, 17))).toBeNull();
  });

  it("does not replace the browser clipboard for a range spanning assistant messages", () => {
    const firstMessage = mountFixture();
    const secondMessage = mountFixture();
    const firstText = fixtureElement(firstMessage, '[data-paseo-markdown-tag="strong"]');
    const secondText = fixtureElement(secondMessage, '[data-paseo-markdown-tag="strong"]');
    expect(copiedMarkdown(selectRange(firstText, 0, secondText, 4))).toBeNull();
  });

  it("preserves all structure when the complete assistant message is selected", () => {
    const message = mountFixture();
    const content = createAssistantSelectionClipboardContent(selectNodeContents(message));
    expect(content?.plainText).toBe(
      [
        "Prefix **bold text** and `inline code` suffix.",
        "",
        "- First bullet text",
        "- Second bullet text",
        "",
        "```ts",
        "const answer = true;",
        "```",
      ].join("\n"),
    );
    expect(content?.html).not.toContain("<ul>");
    expect(content?.html).not.toContain("<li>");
    expect(content?.html).toContain("<div>- First bullet text</div>");
    expect(content?.html).toContain("<div>- Second bullet text</div>");
  });

  it.each([
    { tag: "strong", range: [1, 5], expected: "old", forbiddenHtml: "<strong>" },
    { tag: "code", range: [2, 8], expected: "line c", forbiddenHtml: "<code>" },
  ])(
    "copies a partial $tag range without expanding to its delimiters",
    ({ tag, range, expected, forbiddenHtml }) => {
      const message = mountFixture();
      const element = fixtureElement(message, `[data-paseo-markdown-tag="${tag}"]`);
      const content = createAssistantSelectionClipboardContent(
        selectText(element, range[0], range[1]),
      );
      expect(content?.plainText).toBe(expected);
      expect(content?.html).not.toContain(forbiddenHtml);
    },
  );

  it.each(["strong", "em", "s", "h2", "blockquote"])(
    "copies all content selected from inside a %s element without its syntax",
    (tag) => {
      const message = mountFixture();
      const element = fixtureElement(message, '[data-paseo-markdown-tag="strong"]');
      element.setAttribute("data-paseo-markdown-tag", tag);
      const content = createAssistantSelectionClipboardContent(
        selectText(element, 0, textNode(element).length),
      );
      expect(content?.plainText).toBe("bold text");
      expect(content?.html).not.toContain(`<${tag}>`);
    },
  );

  it("copies complete inline code without delimiters when the selection stays inside", () => {
    const message = mountFixture();
    const element = fixtureElement(message, '[data-paseo-markdown-tag="code"]');
    const content = createAssistantSelectionClipboardContent(
      selectText(element, 0, textNode(element).length),
    );
    expect(content?.plainText).toBe("inline code");
    expect(content?.html).not.toContain("<code>");
  });

  it("keeps a complete inline node but drops formatting from a partial node at the other edge", () => {
    const message = mountFixture();
    const strong = fixtureElement(message, '[data-paseo-markdown-tag="strong"]');
    const code = fixtureElement(message, '[data-paseo-markdown-tag="code"]');
    expect(copiedMarkdown(selectRange(strong, 0, code, 6))).toBe("**bold text** and inline");
  });

  it("copies list-item text without inventing a bullet", () => {
    const message = mountFixture();
    const itemText = fixtureElement(message, '[data-paseo-markdown-tag="li"] div span');
    const content = createAssistantSelectionClipboardContent(
      selectText(itemText, 0, textNode(itemText).length),
    );
    expect(content?.plainText).toBe("First bullet text");
    expect(content?.html).toContain("<p>First bullet text</p>");
    expect(content?.html).not.toContain("<li>");
  });

  it("retains a bullet when the range includes the marker and the complete item", () => {
    const message = mountFixture();
    const item = fixtureElement(message, '[data-paseo-markdown-tag="li"]');
    expect(copiedMarkdown(selectNodeContents(item))).toBe("- First bullet text");
  });

  it("retains a bullet when a drag selects from the rendered marker through the item text", () => {
    const message = mountFixture();
    const marker = fixtureElement(message, '[data-paseo-markdown-list-marker="true"]');
    const itemText = fixtureElement(message, '[data-paseo-markdown-tag="li"] div span');

    const content = createAssistantSelectionClipboardContent(
      selectRange(marker, 0, itemText, textNode(itemText).length),
    );
    expect(content?.plainText).toBe("- First bullet text");
    expect(content?.html).toContain("<div>- First bullet text</div>");
    expect(content?.html).not.toContain("<ul>");
    expect(content?.html).not.toContain("<li>");
  });

  it("retains a bullet when a drag includes the marker and part of the item text", () => {
    const message = mountFixture();
    const marker = fixtureElement(message, '[data-paseo-markdown-list-marker="true"]');
    const itemText = fixtureElement(message, '[data-paseo-markdown-tag="li"] div span');

    expect(copiedMarkdown(selectRange(marker, 0, itemText, 5))).toBe("- First");
  });

  it("does not invent a bullet when a drag starts after the rendered marker", () => {
    const message = mountFixture();
    const marker = fixtureElement(message, '[data-paseo-markdown-list-marker="true"]');
    const itemText = fixtureElement(message, '[data-paseo-markdown-tag="li"] div span');

    expect(
      copiedMarkdown(
        selectRange(marker, textNode(marker).length, itemText, textNode(itemText).length),
      ),
    ).toBe("First bullet text");
  });

  it("retains every selected marker across a partial multi-item drag", () => {
    const message = mountFixture();
    const markerSelector = '[data-paseo-markdown-list-marker="true"]';
    const textSelector = '[data-paseo-markdown-tag="li"] div span';
    const firstMarker = fixtureElement(message, markerSelector);
    const secondText = fixtureElement(message, textSelector, 1);

    expect(copiedMarkdown(selectRange(firstMarker, 0, secondText, 6))).toBe(
      "- First bullet text\n- Second",
    );
  });

  it("retains the original number when a marker drag starts mid-list", () => {
    const message = mountFixture();
    const list = fixtureElement(message, '[data-paseo-markdown-tag="ul"]');
    list.setAttribute("data-paseo-markdown-tag", "ol");
    list.setAttribute("data-paseo-markdown-list-start", "5");
    const markers = list.querySelectorAll<HTMLElement>('[data-paseo-markdown-list-marker="true"]');
    markers.item(0).textContent = "5.";
    markers.item(1).textContent = "6.";
    const secondMarker = fixtureElement(list, '[data-paseo-markdown-list-marker="true"]', 1);
    const secondText = fixtureElement(list, '[data-paseo-markdown-tag="li"] div span', 1);

    expect(
      copiedMarkdown(selectRange(secondMarker, 0, secondText, textNode(secondText).length)),
    ).toBe("6. Second bullet text");
  });

  it("keeps the next number when a drag crosses a code block nested in an item", () => {
    const message = mountFixture();
    const list = fixtureElement(message, '[data-paseo-markdown-tag="ul"]');
    list.outerHTML = [
      '<div data-paseo-markdown-tag="ol" data-paseo-markdown-list-start="1">',
      '<div data-paseo-markdown-tag="li">',
      '<div data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">1.</div>',
      "<div><div><span>Install it:</span></div>",
      '<div data-paseo-markdown-tag="pre" data-paseo-markdown-language="sh">',
      '<div data-paseo-markdown-tag="code"><span>brew install foo</span></div>',
      '<button data-paseo-markdown-ignore="true">Copy</button>',
      "</div></div>",
      "</div>",
      '<div data-paseo-markdown-tag="li">',
      '<div data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">2.</div>',
      "<div><div><span>Done.</span></div></div>",
      "</div>",
      "</div>",
    ].join("");

    const content = copyAcross(message, "Install it:", "Done.");

    expect(content?.plainText).toBe("Install it:\n\n```sh\nbrew install foo\n```\n\n2. Done.");
    expect(content?.html).toContain("<div>2. Done.</div>");
  });

  it("retains nested markers when a drag includes the complete outer item", () => {
    const message = mountFixture();
    const firstItem = fixtureElement(message, '[data-paseo-markdown-tag="li"]');
    firstItem.innerHTML = [
      '<span data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">•</span>',
      "<div>",
      "<span>Outer text</span>",
      '<div data-paseo-markdown-tag="ul">',
      '<div data-paseo-markdown-tag="li">',
      '<span data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">•</span>',
      "<div><span>Inner text</span></div>",
      "</div>",
      "</div>",
      "</div>",
    ].join("");
    const outerMarker = fixtureElement(
      firstItem,
      ':scope > [data-paseo-markdown-list-marker="true"]',
    );
    const innerText = fixtureElement(
      firstItem,
      ':scope [data-paseo-markdown-tag="ul"] > [data-paseo-markdown-tag="li"] > div > span',
    );

    expect(copiedMarkdown(selectRange(outerMarker, 0, innerText, textNode(innerText).length))).toBe(
      "- Outer text\n    - Inner text",
    );
  });

  it("preserves paragraph breaks when rich HTML flattens a loose list item", () => {
    const message = mountFixture();
    const item = fixtureElement(message, '[data-paseo-markdown-tag="li"]');
    item.replaceChildren();
    item.insertAdjacentHTML(
      "beforeend",
      '<div data-paseo-markdown-tag="p">First paragraph</div><div data-paseo-markdown-tag="p">Second paragraph</div>',
    );

    const content = createAssistantSelectionClipboardContent(selectNodeContents(item));
    expect(content?.plainText).toBe("- First paragraph\n\n    Second paragraph");
    expect(content?.html).toMatch(/<div>-\s*First paragraph\s*<br><br>Second paragraph\s*<\/div>/);
  });

  it("omits a partial leading bullet and retains the marker crossed before the trailing item", () => {
    const message = mountFixture();
    const selector = '[data-paseo-markdown-tag="li"] div span';
    const first = fixtureElement(message, selector);
    const second = fixtureElement(message, selector, 1);
    expect(copiedMarkdown(selectRange(first, 6, second, textNode(second).length))).toBe(
      "bullet text\n\n- Second bullet text",
    );
  });

  it("copies part of a fenced code block without adding an inline or fenced delimiter", () => {
    const message = mountFixture();
    const blockCode = fixtureElement(
      message,
      '[data-paseo-markdown-tag="pre"] [data-paseo-markdown-tag="code"]',
    );
    const content = createAssistantSelectionClipboardContent(selectText(blockCode, 6, 12));
    expect(content?.plainText).toBe("answer");
    expect(content?.html).not.toContain("<code>");
    expect(content?.html).not.toContain("<pre>");
  });

  it("copies an image as its Markdown when the selection stays inside the rendered image", () => {
    const message = mountFixture();
    const frame = document.createElement("div");
    frame.setAttribute("data-paseo-markdown-tag", "img");
    frame.setAttribute("data-paseo-markdown-src", "https://example.test/chart.png");
    frame.setAttribute("data-paseo-markdown-alt", "chart");
    frame.innerHTML = '<div><div><img src="blob:https://example.test/preview" alt=""></div></div>';
    message.prepend(frame);

    expect(copiedMarkdown(selectNodeContents(fixtureElement(frame, "img").parentElement!))).toBe(
      "![chart](https://example.test/chart.png)",
    );
  });

  it("copies code without a fence when every character is selected inside the block", () => {
    const message = mountFixture();
    const blockCode = fixtureElement(
      message,
      '[data-paseo-markdown-tag="pre"] [data-paseo-markdown-tag="code"]',
    );
    expect(copiedMarkdown(selectText(blockCode, 0, textNode(blockCode).length))).toBe(
      "const answer = true;",
    );
  });
});

/**
 * The fixture above holds a code block in one text node. The real renderer splits a
 * highlighted line across one text node per syntax token and emits each newline as a
 * node of its own (`highlighted-code-block.tsx`), and it puts the hover Copy button
 * inside the `pre`. Line breaks and indentation only survive if the code skips
 * Turndown, so those cases need a fixture shaped like the real thing.
 */
function highlightedFixture(language: string | null): string {
  return [
    '<div data-testid="assistant-message">',
    '<div data-paseo-markdown-tag="p"><span>Before the block.</span></div>',
    highlightedCodeBlock(language),
    '<div data-paseo-markdown-tag="p"><span>After the block.</span></div>',
    "</div>",
  ].join("");
}

function highlightedCodeBlock(language: string | null): string {
  const languageAttribute =
    language === null ? "" : ` data-paseo-markdown-language="${escapeAttribute(language)}"`;
  return [
    `<div data-paseo-markdown-tag="pre"${languageAttribute}>`,
    '<span data-paseo-markdown-tag="code">',
    "<span>const</span><span> answer</span><span> = 1;</span>",
    "<span>\n</span>",
    "<span>  if</span><span> (answer)</span><span> {</span>",
    "<span>\n</span>",
    "<span>    doThing();</span>",
    "</span>",
    '<div data-paseo-markdown-ignore="true"><span>Copy</span></div>',
    "</div>",
  ].join("");
}

function escapeAttribute(value: string): string {
  const holder = document.createElement("div");
  holder.setAttribute("data-value", value);
  return holder.outerHTML.slice('<div data-value="'.length, -"></div>".length);
}

function mountHighlighted(language: string | null = "typescript"): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = highlightedFixture(language);
  document.body.append(host);
  const message = host.querySelector<HTMLElement>('[data-testid="assistant-message"]');
  if (!message) {
    throw new Error("Expected assistant message fixture");
  }
  return message;
}

/** The single text node whose content is exactly `text`. */
function tokenText(root: Node, text: string): Text {
  const matches = allTextNodes(root, text);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one text node "${text}", found ${matches.length}`);
  }
  return matches[0];
}

function allTextNodes(root: Node, text: string): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const matches: Text[] = [];
  while (walker.nextNode()) {
    if (walker.currentNode.textContent === text) {
      matches.push(walker.currentNode as Text);
    }
  }
  return matches;
}

/** The standalone `\n` node that ends rendered code line `index`. */
function lineBreak(root: Node, index: number): Text {
  const breaks = allTextNodes(root, "\n");
  const node = breaks[index];
  if (!node) {
    throw new Error(`Expected a line break at index ${index}, found ${breaks.length}`);
  }
  return node;
}

function copyBetween(start: [Text, number], end: [Text, number]) {
  const range = document.createRange();
  range.setStart(start[0], start[1]);
  range.setEnd(end[0], end[1]);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Expected browser selection");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return createAssistantSelectionClipboardContent(selection);
}

/** Select from the start of one text node to the end of another. */
function copyAcross(root: Node, startText: string, endText: string) {
  return copyBetween([tokenText(root, startText), 0], [tokenText(root, endText), endText.length]);
}

describe("assistant selection copy inside highlighted code", () => {
  it("keeps the line break and the indentation of a partial multi-line selection", () => {
    const message = mountHighlighted();

    const content = copyAcross(message, "const", " {");

    expect(content?.plainText).toBe("const answer = 1;\n  if (answer) {");
  });

  it("keeps multi-line code as a block in the html half so the lines survive", () => {
    const message = mountHighlighted();

    const content = copyAcross(message, "const", " {");

    expect(content?.html).toBe(
      '<meta charset="utf-8"><pre><code class="language-typescript">const answer = 1;\n  if (answer) {</code></pre>',
    );
  });

  it("does not escape Markdown characters inside copied code", () => {
    const message = mountHighlighted();

    const content = copyBetween([tokenText(message, " = 1;"), 1], [tokenText(message, " = 1;"), 5]);

    expect(content?.plainText).toBe("= 1;");
  });

  it("handles a common ancestor that is an element rather than a text node", () => {
    const message = mountHighlighted();

    // Spanning two token spans makes `commonAncestorContainer` the `code` element.
    const content = copyBetween(
      [tokenText(message, "const"), 1],
      [tokenText(message, " answer"), 4],
    );

    expect(content?.plainText).toBe("onst ans");
  });

  it("drops a trailing line break swept in from the end of a line", () => {
    const message = mountHighlighted();

    const content = copyBetween([tokenText(message, " = 1;"), 1], [lineBreak(message, 0), 1]);

    expect(content?.plainText).toBe("= 1;");
  });

  it("drops a trailing line break together with the indentation after it", () => {
    const message = mountHighlighted();

    const content = copyBetween([tokenText(message, "const"), 0], [tokenText(message, "  if"), 2]);

    expect(content?.plainText).toBe("const answer = 1;");
  });

  it("keeps line breaks that are not at the end of the selection", () => {
    const message = mountHighlighted();

    const content = copyBetween([tokenText(message, "const"), 0], [tokenText(message, "  if"), 4]);

    expect(content?.plainText).toBe("const answer = 1;\n  if");
  });

  it("leaves the hover copy button out of the copied code", () => {
    const message = mountHighlighted();

    const content = copyAcross(message, " answer", "Copy");

    expect(content?.plainText).toBe(" answer = 1;\n  if (answer) {\n    doThing();");
    expect(content?.plainText).not.toContain("Copy");
  });

  it("does not treat a selection inside the copy button as code", () => {
    const message = mountHighlighted();

    expect(copyAcross(message, "Copy", "Copy")).toBeNull();
  });

  it("omits the language class when the fence carries no info string", () => {
    const message = mountHighlighted(null);

    const content = copyAcross(message, "const", " {");

    expect(content?.html).toBe(
      '<meta charset="utf-8"><pre><code>const answer = 1;\n  if (answer) {</code></pre>',
    );
  });

  it("escapes a fence info string that would break out of the class attribute", () => {
    const message = mountHighlighted('ts" onload="x');

    const content = copyAcross(message, "const", " {");

    expect(content?.html).toContain('class="language-ts&quot; onload=&quot;x"');
    expect(content?.html).not.toContain('onload="x"');
  });

  it("copies a fully selected multi-line region as code when the selection stays inside", () => {
    const message = mountHighlighted();
    const blockCode = fixtureElement(
      message,
      '[data-paseo-markdown-tag="pre"] [data-paseo-markdown-tag="code"]',
    );

    expect(copiedMarkdown(selectNodeContents(blockCode))).toBe(
      "const answer = 1;\n  if (answer) {\n    doThing();",
    );
  });

  // A drag that starts or ends in the gap beside a block anchors the selection at the
  // edge of the neighbouring block. Nothing outside the code is highlighted or selected.
  it("copies code without a fence when the selection only touches the end of the block before it", () => {
    const message = mountHighlighted();
    const before = tokenText(message, "Before the block.");

    const content = copyBetween(
      [before, before.length],
      [tokenText(message, "    doThing();"), 14],
    );

    expect(content?.plainText).toBe("const answer = 1;\n  if (answer) {\n    doThing();");
  });

  it("copies code without a fence when the selection only touches the start of the block after it", () => {
    const message = mountHighlighted();

    const content = copyBetween(
      [tokenText(message, "const"), 0],
      [tokenText(message, "After the block."), 0],
    );

    expect(content?.plainText).toBe("const answer = 1;\n  if (answer) {\n    doThing();");
  });

  it("copies code without a fence when the selection only touches the row before the block", () => {
    const transcript = mountTranscript([{ messageId: "message-1", blocks: ["Run this:", "code"] }]);
    const codeRow = transcript.querySelectorAll('[data-testid="assistant-message"]')[1]!;
    codeRow.innerHTML = highlightedCodeBlock("typescript");
    const before = tokenText(transcript, "Run this:");

    const content = copyBetween(
      [before, before.length],
      [tokenText(transcript, "    doThing();"), 14],
    );

    expect(content?.plainText).toBe("const answer = 1;\n  if (answer) {\n    doThing();");
  });

  it("keeps an image selected beside the code in the copy", () => {
    const message = mountHighlighted();
    const image = document.createElement("div");
    image.setAttribute("data-paseo-markdown-tag", "p");
    // The rendered `img` shows a preview URL with no alt text; the frame carries the Markdown.
    image.innerHTML =
      '<div data-paseo-markdown-tag="img" data-paseo-markdown-src="https://example.test/chart.png" data-paseo-markdown-alt="chart"><img src="blob:https://example.test/preview" alt=""></div>';
    message.querySelector('[data-paseo-markdown-tag="pre"]')!.before(image);
    const before = tokenText(message, "Before the block.");

    const content = copyBetween(
      [before, before.length],
      [tokenText(message, "    doThing();"), 14],
    );

    expect(content?.plainText).toBe(
      "![chart](https://example.test/chart.png)\n\n```typescript\nconst answer = 1;\n  if (answer) {\n    doThing();\n```",
    );
  });

  it("retains the fence when a complete code block is selected across its boundary", () => {
    const message = mountHighlighted();

    const content = copyAcross(message, "const", "After the block.");

    expect(content?.plainText).toBe(
      "```typescript\nconst answer = 1;\n  if (answer) {\n    doThing();\n```\n\nAfter the block.",
    );
  });

  it("keeps line breaks when a quote selection ends partway through code", () => {
    const message = mountHighlighted();
    const quote = document.createElement("div");
    quote.setAttribute("data-paseo-markdown-tag", "blockquote");
    quote.textContent = "Quoted context";
    message.querySelector('[data-paseo-markdown-tag="pre"]')!.before(quote);

    const content = copyBetween(
      [tokenText(message, "Quoted context"), 0],
      [tokenText(message, " (answer)"), 9],
    );

    expect(content?.plainText).toBe(
      "> Quoted context\n\n```typescript\nconst answer = 1;\n  if (answer)\n```",
    );
  });

  it("keeps indented code lines inside their list item", () => {
    const host = document.createElement("div");
    host.innerHTML = [
      '<div data-testid="assistant-message">',
      '<div data-paseo-markdown-tag="ol" data-paseo-markdown-list-start="1">',
      '<div data-paseo-markdown-tag="li">',
      '<div data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">1.</div>',
      '<div><div data-paseo-markdown-tag="p"><span>Item text</span></div>',
      highlightedCodeBlock("typescript"),
      "</div></div></div></div>",
    ].join("");
    document.body.append(host);

    const content = copyBetween([tokenText(host, "1."), 0], [tokenText(host, " (answer)"), 9]);

    expect(content?.plainText).toBe(
      "1. Item text\n\n    ```typescript\n    const answer = 1;\n      if (answer)\n    ```",
    );
  });

  it("keeps line breaks when a selection starts partway through code", () => {
    const message = mountHighlighted();

    const content = copyBetween(
      [tokenText(message, " answer"), 1],
      [tokenText(message, "After the block."), "After the block.".length],
    );

    expect(content?.plainText).toBe(
      "```typescript\nanswer = 1;\n  if (answer) {\n    doThing();\n```\n\nAfter the block.",
    );
  });
});

describe("semantic library output", () => {
  it("copies a partial strong span as plain text", () => {
    const host = document.createElement("div");
    host.innerHTML =
      '<div data-testid="assistant-message"><p>Before <strong>bold text</strong> after</p></div>';
    document.body.append(host);
    const text = host.querySelector("strong")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(createAssistantSelectionClipboardContent(selection)?.plainText).toBe("old");
    expect(createAssistantSelectionClipboardContent(selection)?.html).not.toContain("<strong>");
    host.remove();
  });
});

it("copies native semantic ordered lists with their original numbers", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div data-testid="assistant-message"><ol start="3"><li>Third item</li><li>Fourth item</li></ol></div>';
  document.body.append(host);
  const selection = selectNodeContents(host.querySelector("ol")!);
  const content = createAssistantSelectionClipboardContent(selection);
  expect(content?.plainText).toContain("3. Third item");
  expect(content?.plainText).toContain("4. Fourth item");
  host.remove();
});

it("copies a selection inside semantic inline code without Markdown escaping", () => {
  const message = mountFixture();
  message.innerHTML = "<p>Run <code>apply_patch</code> now.</p>";
  const code = fixtureElement(message, "code");
  expect(createAssistantSelectionClipboardContent(selectText(code, 0, 11))?.plainText).toBe(
    "apply_patch",
  );
});

it("keeps intraword underscores in prose unescaped", () => {
  const message = mountFixture();
  message.innerHTML = "<p>Set max_retries and snake_case before the call.</p>";
  const paragraph = fixtureElement(message, "p");
  expect(createAssistantSelectionClipboardContent(selectNodeContents(paragraph))?.plainText).toBe(
    "Set max_retries and snake_case before the call.",
  );
});

it("copies literal paired underscores raw in text/plain and escaped in text/html", () => {
  const message = mountFixture();
  message.innerHTML = "<p>literal _word_ stays literal</p>";
  const paragraph = fixtureElement(message, "p");
  const content = createAssistantSelectionClipboardContent(selectNodeContents(paragraph));
  expect(content?.plainText).toBe("literal _word_ stays literal");
  expect(content?.html).toContain("literal _word_ stays literal");
});

it("copies a path the renderer recognized as text, and an authored link as a link", () => {
  const message = mountFixture();
  message.innerHTML =
    '<p>See <a href="src/index.ts" data-paseo-markdown-recognized-link="true">src/index.ts</a> and <a href="https://example.test/doc">the doc</a>.</p>';
  const content = createAssistantSelectionClipboardContent(selectNodeContents(message));
  expect(content?.plainText).toBe("See src/index.ts and [the doc](https://example.test/doc).");
  expect(content?.html).not.toContain('href="src/index.ts"');
});

it("copies a recognized inline-code path without its link", () => {
  const message = mountFixture();
  message.innerHTML =
    '<p>Edited <a href="src/app.tsx" data-paseo-markdown-recognized-link="true"><code>src/app.tsx</code></a> today.</p>';
  const content = createAssistantSelectionClipboardContent(selectNodeContents(message));
  expect(content?.plainText).toBe("Edited `src/app.tsx` today.");
  expect(content?.html).not.toContain('href="src/app.tsx"');
});

it("copies a recognized web link as its text in text/plain and as a link in text/html", () => {
  const message = mountFixture();
  message.innerHTML =
    '<p>Fixed in <a href="https://github.com/o/r/issues/12" data-paseo-markdown-recognized-link="true">#12</a> today.</p>';
  const content = createAssistantSelectionClipboardContent(selectNodeContents(message));
  expect(content?.plainText).toBe("Fixed in #12 today.");
  expect(content?.html).toContain('<a href="https://github.com/o/r/issues/12">#12</a>');
});

it("copies a recognized Windows drive path as text in both clipboard flavors", () => {
  const message = mountFixture();
  message.innerHTML =
    '<p>Open <a href="C:%5Crepo%5Csrc%5Cx.ts" data-paseo-markdown-recognized-link="true">C:\\repo\\src\\x.ts</a> now.</p>';
  const content = createAssistantSelectionClipboardContent(selectNodeContents(message));
  expect(content?.plainText).toBe("Open C:\\repo\\src\\x.ts now.");
  expect(content?.html).not.toContain("<a ");
});

it("keeps literal angle brackets around a URL in text/html", () => {
  const message = mountFixture();
  message.innerHTML = "<p>Open &lt;http://localhost:3000&gt; before the call.</p>";
  const content = createAssistantSelectionClipboardContent(selectNodeContents(message));
  expect(content?.plainText).toBe("Open <http://localhost:3000> before the call.");
  expect(content?.html).toContain("<p>Open &lt;http://localhost:3000&gt; before the call.</p>");
});

it("keeps a heading marker split across inline elements literal in text/html", () => {
  const message = mountFixture();
  message.innerHTML = "<p>Use <strong>C#</strong> for the service layer.</p>";
  const paragraph = fixtureElement(message, "p");
  const range = document.createRange();
  range.setStart(textNode(fixtureElement(message, "strong")), 1);
  range.setEnd(paragraph.lastChild!, paragraph.lastChild!.textContent!.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const content = createAssistantSelectionClipboardContent(selection);
  expect(content?.plainText).toBe("# for the service layer.");
  expect(content?.html).toContain("<p># for the service layer.</p>");
});

it("keeps table cell pipes escaped in text/plain table syntax and literal in text/html", () => {
  const message = mountFixture();
  message.innerHTML =
    "<table><thead><tr><th>Header | label</th></tr></thead><tbody><tr><td>Value | detail</td></tr></tbody></table>";
  const content = createAssistantSelectionClipboardContent(selectNodeContents(message));
  expect(content?.plainText).toContain("Header \\| label");
  expect(content?.plainText).toContain("Value \\| detail");
  expect(content?.html).toContain("<th>Header | label</th>");
  expect(content?.html).toContain("<td>Value | detail</td>");
});

it("copies a workspace image path instead of its temporary display URL", () => {
  const message = mountFixture();
  const sources = JSON.stringify({ "blob:preview": "assets/chart.png" });
  message.innerHTML = '<div><img src="blob:preview" alt="chart"></div>';
  message.firstElementChild!.setAttribute("data-paseo-markdown-image-sources", sources);
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNode(message.querySelector("img")!);
  selection.removeAllRanges();
  selection.addRange(range);
  expect(createAssistantSelectionClipboardContent(selection)?.plainText).toBe(
    "![chart](assets/chart.png)",
  );
});

describe("assistant selection quote", () => {
  it("quotes prose and lists with the Markdown Copy writes", () => {
    const message = mountFixture();
    const selection = selectNodeContents(message);

    const quote = createAssistantSelectionMarkdown(selection);

    expect(quote).toBe(copiedMarkdown(selection));
    expect(quote).toContain("**bold text**");
    expect(quote).toContain("- First bullet text");
  });

  it("does not quote a collapsed or non-assistant selection", () => {
    const message = mountFixture();
    expect(
      createAssistantSelectionMarkdown(selectText(fixtureElement(message, "span"), 2, 2)),
    ).toBe(null);
    const outside = document.createElement("p");
    outside.textContent = "Outside the transcript";
    document.body.append(outside);
    expect(createAssistantSelectionMarkdown(selectText(outside, 0, 7))).toBe(null);
  });

  it("keeps lines of a code block as a fence with its language", () => {
    const message = mountHighlighted();
    const range = document.createRange();
    range.setStart(tokenText(message, "const"), 0);
    range.setEnd(tokenText(message, " {"), 2);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(createAssistantSelectionMarkdown(selection)).toBe(
      "```typescript\nconst answer = 1;\n  if (answer) {\n```",
    );
  });

  it("keeps part of inline code as a code span that outlasts its backticks", () => {
    const message = mountFixture();
    message.innerHTML = "<p>Run <code>a`b apply</code> now.</p>";
    const code = fixtureElement(message, "code");

    expect(createAssistantSelectionMarkdown(selectText(code, 0, 3))).toBe("``a`b``");
  });

  it("keeps the spaces at the edges of part of inline code when the quote renders", () => {
    const message = mountFixture();
    message.innerHTML = "<p>Run <code>if (ready)    return  done</code> now.</p>";
    const code = fixtureElement(message, "code");
    const parser = createMarkdownParser({ linkify: false });
    const rendered = (markdown: string | null) =>
      parser
        .parseInline(markdown ?? "", {})[0]
        ?.children?.find((token) => token.type === "code_inline")?.content;

    for (const [start, end] of [
      [10, 21],
      [10, 20],
      [14, 22],
    ]) {
      const selected = code.textContent?.slice(start, end);
      expect(rendered(createAssistantSelectionMarkdown(selectText(code, start, end)))).toBe(
        selected,
      );
    }
    expect(createAssistantSelectionMarkdown(selectText(code, 20, 22))).toBe("`  `");
  });
});
