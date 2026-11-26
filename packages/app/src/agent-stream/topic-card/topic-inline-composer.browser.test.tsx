import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import { TopicInlineComposer } from "./topic-inline-composer";
import { buildTopicReplyDraftKey, useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import { filesToImageAttachments } from "@/utils/image-attachments-from-files";

vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/utils/image-attachments-from-files", async (original) => ({
  ...(await original<typeof import("@/utils/image-attachments-from-files")>()),
  filesToImageAttachments: vi.fn(),
}));

vi.mock("@/attachments/use-attachment-preview-url", () => ({
  useAttachmentPreviewUrl: () => ({ status: "ready", url: "data:image/png;base64,AA==" }),
}));

beforeEach(() => {
  vi.stubGlobal("React", React);
  useTopicStreamViewStore.setState({ inlineReplyDrafts: {} });
  vi.mocked(filesToImageAttachments).mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const image: AttachmentMetadata = {
  id: "image-id",
  mimeType: "image/png",
  storageType: "web-indexeddb",
  storageKey: "image-id",
  fileName: "clip.png",
  createdAt: 0,
};

function clipboardPaste(editor: HTMLElement, clipboardData: DataTransfer) {
  const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
  fireEvent(editor, paste);
  return paste;
}

function imageClipboard(type = "image/png") {
  const clipboard = new DataTransfer();
  clipboard.items.add(new File(["png bytes"], "clip.png", { type }));
  return clipboard;
}

function composer(topicKey: string, submit = vi.fn(() => true)) {
  const queryClient = new QueryClient();
  const renderTopic = (key: string) => (
    <QueryClientProvider client={queryClient}>
      <TopicInlineComposer
        agentKey="controller"
        topicKey={key}
        hasLeadAgent={false}
        onSubmitDesktopReply={submit}
        onActivateCompactReply={vi.fn()}
      />
    </QueryClientProvider>
  );
  const view = render(renderTopic(topicKey));
  return {
    ...view,
    submit,
    switchTopic: (key: string) => view.rerender(renderTopic(key)),
    open: (key: string) => {
      fireEvent.click(view.getByTestId(`topic-inline-reply-trigger-${key}`));
      return view.getByTestId(`topic-inline-reply-input-${key}`) as HTMLInputElement;
    },
  };
}

it("lets text paste through and blocks button and Enter until an image is ready, including after blur", async () => {
  const conversion = Promise.withResolvers<AttachmentMetadata[]>();
  vi.mocked(filesToImageAttachments).mockReturnValueOnce(conversion.promise);
  const view = composer("first");
  const editor = view.open("first");
  const send = view.getByTestId("topic-inline-reply-send-first");
  act(() => editor.focus());
  const plain = new DataTransfer();
  plain.setData("text/plain", "keep this text");
  expect(clipboardPaste(editor, plain).defaultPrevented).toBe(false);
  expect(clipboardPaste(editor, imageClipboard("image/svg+xml")).defaultPrevented).toBe(false);
  expect(filesToImageAttachments).not.toHaveBeenCalled();

  fireEvent.change(editor, { target: { value: "keep this text" } });
  expect(clipboardPaste(editor, imageClipboard()).defaultPrevented).toBe(true);
  expect(send.getAttribute("aria-disabled")).toBe("true");
  fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
  act(() => editor.blur());
  fireEvent.click(send);
  expect(view.submit).not.toHaveBeenCalled();

  await act(async () => conversion.resolve([image]));
  expect(view.getByTestId("topic-inline-reply-image-preview")).toBeTruthy();
  expect(document.activeElement).not.toBe(editor);
  await act(async () => fireEvent.click(send));
  expect(view.submit).toHaveBeenCalledWith("keep this text", "auto", expect.any(String), [
    { kind: "image", metadata: image },
  ]);
});

it("drops conversions from a previous topic and removes quotes without removing images", async () => {
  const conversion = Promise.withResolvers<AttachmentMetadata[]>();
  vi.mocked(filesToImageAttachments).mockReturnValueOnce(conversion.promise);
  const view = composer("old");
  clipboardPaste(view.open("old"), imageClipboard());
  view.switchTopic("next");

  const draftKey = buildTopicReplyDraftKey({
    serverId: "",
    workspaceId: "",
    agentId: "controller",
    topicKey: "next",
  });
  const quote = {
    kind: "quote" as const,
    id: "quote-id",
    text: "Quoted update",
    label: "Reviewer",
  };
  act(() => {
    useTopicStreamViewStore.getState().updateInlineReplyDraft(draftKey, (draft) => ({
      ...draft,
      attachments: [{ kind: "image", metadata: image }, quote],
    }));
  });
  expect(view.getByTestId("composer-quote-card").textContent).toContain("Reviewer");
  await act(async () => conversion.resolve([{ ...image, id: "old-image" }]));
  expect(view.getAllByTestId("topic-inline-reply-image-preview")).toHaveLength(1);
  fireEvent.click(view.getByTestId("composer-quote-card-remove"));
  expect(useTopicStreamViewStore.getState().inlineReplyDrafts[draftKey]?.attachments).toEqual([
    { kind: "image", metadata: image },
  ]);
  view.switchTopic("old");
  expect(view.queryByTestId("topic-inline-reply-image-preview")).toBeNull();
  expect(view.getByTestId("topic-inline-reply-trigger-old")).toBeTruthy();
});

it("rejects invalid sizes and reports a conversion failure without locking the draft", async () => {
  vi.mocked(filesToImageAttachments).mockResolvedValueOnce([]);
  const view = composer("failure");
  const editor = view.open("failure");
  const empty = new DataTransfer();
  empty.items.add(new File([], "empty.png", { type: "image/png" }));
  expect(clipboardPaste(editor, empty).defaultPrevented).toBe(true);
  expect(filesToImageAttachments).not.toHaveBeenCalled();
  expect(view.getByRole("alert")).toBeTruthy();
  fireEvent.change(editor, { target: { value: "draft" } });
  clipboardPaste(editor, imageClipboard());
  await waitFor(() => {
    expect(
      view.getByTestId("topic-inline-reply-send-failure").getAttribute("aria-disabled"),
    ).not.toBe("true");
  });
  expect(view.getByRole("alert")).toBeTruthy();
  expect(editor.value).toBe("draft");
});
