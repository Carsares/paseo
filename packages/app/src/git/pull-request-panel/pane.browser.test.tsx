import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, within } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachments,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { composerWorkspaceAttachment } from "@/composer/attachments/workspace";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { ToastApiProvider } from "@/contexts/toast-context";
import type { ToastApi } from "@/components/toast-host";
import type { PrPaneCheck, PrPaneData } from "./data";
import { PullRequestPane } from "./pane";
import { reviewGuideEnglish as copy } from "./review-guide/copy";
import { useReviewDrafts } from "./review-guide/drafts";
import type {
  ReviewGuide,
  ReviewGuideConnection,
  ReviewGuidePort,
  ReviewIdentity,
} from "./review-guide/port";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const PANE_HEIGHT = 600;

const silentToasts: ToastApi = {
  show: () => () => {},
  copied: () => {},
  error: () => {},
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const queryClient = new QueryClient();
const reviewAttachmentScope = buildWorkspaceAttachmentScopeKey({
  serverId: "server-1",
  cwd: "/repo",
});
const noAttachments: [] = [];
const noop = () => {};

function ReviewAttachmentPreview() {
  const workspaceAttachments = useWorkspaceAttachments(reviewAttachmentScope);
  const { selectedAttachments } = composerWorkspaceAttachment.useBinding({
    normalAttachments: noAttachments,
    workspaceAttachments,
  });
  return selectedAttachments.filter(composerWorkspaceAttachment.is).map((attachment, index) =>
    composerWorkspaceAttachment.renderPill({
      attachment,
      index,
      disabled: false,
      onOpen: noop,
      onRemove: noop,
    }),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  queryClient.clear();
  useReviewDrafts.setState({ scopes: {} });
  useWorkspaceAttachmentsStore
    .getState()
    .clearWorkspaceAttachments({ scopeKey: reviewAttachmentScope });
});

function successfulChecks(count: number): PrPaneCheck[] {
  return Array.from({ length: count }, (_, index) => ({
    provider: "github",
    name: `check-${index + 1}`,
    status: "success",
    url: `https://example.test/checks/${index + 1}`,
  }));
}

function pullRequest(checks: PrPaneCheck[]): PrPaneData {
  return {
    provider: { id: "github", label: "GitHub" },
    forge: "github",
    number: 42,
    repoOwner: "acme",
    repoName: "widgets",
    title: "Ship the widget",
    state: "open",
    url: "https://example.test/pull/42",
    reviewDecision: "pending",
    awaitingReviewers: [],
    checks,
    activity: [],
  };
}

/** A phone's home indicator: the pane clears it with bottom padding. */
const HOME_INDICATOR_INSETS = { top: 0, right: 0, bottom: 34, left: 0 };

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

function renderPane(
  data: PrPaneData,
  insets = NO_INSETS,
  reviewGuide?: ReviewGuideConnection,
  cwd = "/repo",
) {
  const attachmentScope = reviewGuide
    ? buildWorkspaceAttachmentScopeKey({ serverId: "server-1", cwd })
    : undefined;
  act(() =>
    root?.render(
      <SafeAreaInsetsContext.Provider value={insets}>
        <ToastApiProvider api={silentToasts}>
          <QueryClientProvider client={queryClient}>
            <PullRequestPane
              serverId="server-1"
              cwd={cwd}
              data={data}
              activityLoading={false}
              workspaceAttachmentScopeKey={attachmentScope}
              reviewGuide={reviewGuide}
            />
            {reviewGuide ? <ReviewAttachmentPreview /> : null}
          </QueryClientProvider>
        </ToastApiProvider>
      </SafeAreaInsetsContext.Provider>,
    ),
  );
}

function mountPane(data: PrPaneData, insets = NO_INSETS, reviewGuide?: ReviewGuideConnection) {
  container = document.createElement("div");
  container.style.height = `${PANE_HEIGHT}px`;
  container.style.width = "600px";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  document.body.appendChild(container);
  root = createRoot(container);
  renderPane(data, insets, reviewGuide);
  const pane = container.querySelector<HTMLElement>('[data-testid="pr-pane"]');
  if (!pane) throw new Error("The pull request pane did not render");
  return pane;
}

/** The pressable row holding the Activity title. */
function activityHeader(pane: HTMLElement): HTMLElement {
  const title = within(pane).getByText(i18n.t("workspace.git.pr.sections.activity"));
  const header = title.closest<HTMLElement>("[tabindex]");
  if (!header) throw new Error("The Activity title is not inside a pressable header");
  return header;
}

function checksRegionBottom(pane: HTMLElement): number {
  return within(pane).getByRole("separator").getBoundingClientRect().top;
}

/** Whether a user sees the element: no scroll container clips it out of view. */
function isOnScreen(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + 8, rect.top + rect.height / 2);
  return hit !== null && element.contains(hit);
}

/** React Native Web reports layout from a ResizeObserver, a frame or two after mounting. */
async function settleLayout() {
  for (let frame = 0; frame < 2; frame++) {
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

/** Drags the separator through each offset from where it starts, releasing at the last one. */
function dragSeparator(pane: HTMLElement, ...deltasY: number[]) {
  const separator = within(pane).getByRole("separator");
  const rect = separator.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;
  const pointer = { pointerId: 1, bubbles: true, cancelable: true, clientX: x, button: 0 };
  act(() => {
    separator.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientY: startY }));
  });
  for (const deltaY of deltasY) {
    act(() => {
      window.dispatchEvent(
        new PointerEvent("pointermove", { ...pointer, clientY: startY + deltaY }),
      );
    });
  }
  const endY = startY + (deltasY.at(-1) ?? 0);
  act(() => {
    window.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientY: endY }));
  });
}

describe("pull request pane layout", () => {
  it("docks a collapsed Activity section to the bottom and gives the checks the pane", async () => {
    const pane = mountPane(pullRequest(successfulChecks(10)));

    act(() => activityHeader(pane).click());

    await expect
      .poll(() => Math.round(activityHeader(pane).getBoundingClientRect().bottom))
      .toBe(Math.round(pane.getBoundingClientRect().bottom));
    const rows = within(pane).getAllByTestId("pr-pane-check-row");
    expect(rows).toHaveLength(10);
    expect(rows.every(isOnScreen)).toBe(true);
  });

  it("keeps keyboard focus on the Activity header while it collapses and expands", () => {
    const pane = mountPane(pullRequest(successfulChecks(3)));
    const header = activityHeader(pane);
    act(() => header.focus());

    act(() => header.click());
    expect(document.activeElement).toBe(header);
    act(() => header.click());
    expect(document.activeElement).toBe(header);
  });

  it("exposes whether Activity is expanded to assistive technology", () => {
    const pane = mountPane(pullRequest(successfulChecks(3)));
    expect(activityHeader(pane).getAttribute("aria-expanded")).toBe("true");

    act(() => activityHeader(pane).click());

    expect(activityHeader(pane).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the Activity header inside the pane when a dragged pane gets short", async () => {
    const pane = mountPane(pullRequest(successfulChecks(30)));
    await settleLayout();
    dragSeparator(pane, PANE_HEIGHT);
    await settleLayout();

    act(() => {
      if (container) container.style.height = "160px";
    });
    await settleLayout();

    await expect
      .poll(() => activityHeader(pane).getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(pane.getBoundingClientRect().bottom);
    expect(isOnScreen(activityHeader(pane))).toBe(true);
  });

  it.each([
    ["5px down", [5]],
    ["400px down", [400]],
    ["up past their end and back down", [-20, 100]],
  ])("gives the checks their earlier share when they grow after a drag %s", async (_name, path) => {
    const pane = mountPane(pullRequest(successfulChecks(2)));
    await settleLayout();
    const drawn = checksRegionBottom(pane);

    dragSeparator(pane, ...path);
    await settleLayout();
    expect(checksRegionBottom(pane)).toBeCloseTo(drawn, 0);

    renderPane(pullRequest(successfulChecks(30)));
    await settleLayout();
    const overview = within(pane).getByTestId("pr-pane-overview");
    expect(overview.getBoundingClientRect().height).toBeCloseTo(PANE_HEIGHT / 2, 0);
  });

  it("resizes the checks against Activity by dragging the separator between them", async () => {
    const pane = mountPane(pullRequest(successfulChecks(30)));
    await settleLayout();
    const before = checksRegionBottom(pane);

    dragSeparator(pane, 120);

    await expect.poll(() => Math.round(checksRegionBottom(pane) - before)).toBe(120);
    expect(activityHeader(pane).getBoundingClientRect().top).toBeGreaterThan(before + 100);
  });

  it("keeps the separator under the pointer when the pane clears a bottom inset", async () => {
    const pane = mountPane(pullRequest(successfulChecks(30)), HOME_INDICATOR_INSETS);
    await settleLayout();
    const before = checksRegionBottom(pane);

    dragSeparator(pane, 120);

    await expect.poll(() => Math.round(checksRegionBottom(pane) - before)).toBe(120);
  });
});

const reviewIdentity: ReviewIdentity = {
  forge: "github",
  host: "example.test",
  projectPath: "acme/widgets",
  number: 42,
};
const reviewVersion = { baseSha: "base-1", headSha: "head-1", startSha: "start-1" };

function makeGuide(overrides: Partial<ReviewGuide> = {}): ReviewGuide {
  return {
    identity: reviewIdentity,
    version: reviewVersion,
    stops: [
      {
        id: "attention",
        path: "src/review.ts",
        reason: "sensitive",
        priority: "attention",
        hunk: {
          oldStart: 4,
          oldCount: 2,
          newStart: 9,
          newCount: 2,
          patch: "@@ -4,2 +9,2 @@\n shared\n-previous setup\n+use new setup",
        },
        line: { oldLine: 5 },
      },
      {
        id: "followup",
        path: "src/review.ts",
        reason: "source",
        priority: "normal",
        hunk: {
          oldStart: 17,
          oldCount: 1,
          newStart: 23,
          newCount: 1,
          patch: "@@ -17 +23 @@\n-old default\n+verified new default",
        },
        line: { newLine: 23 },
      },
      { id: "missing", path: "assets/binary", reason: "unavailable", priority: "mechanical" },
    ],
    coverage: { filesLoaded: 2, totalFiles: 3, hasMore: true, missingPatches: 1 },
    commentMode: "remote",
    viewedMode: "remote",
    ...overrides,
  };
}

function makePort(guide: ReviewGuide = makeGuide()) {
  return {
    getReviewGuide: vi.fn<ReviewGuidePort["getReviewGuide"]>().mockResolvedValue(guide),
    getReviewViewed: vi.fn<ReviewGuidePort["getReviewViewed"]>().mockResolvedValue({ entries: [] }),
    setReviewViewed: vi
      .fn<ReviewGuidePort["setReviewViewed"]>()
      .mockResolvedValue({ path: "src/review.ts", state: "viewed" }),
    publishReviewComment: vi
      .fn<ReviewGuidePort["publishReviewComment"]>()
      .mockResolvedValue(undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function press(element: HTMLElement) {
  act(() => element.click());
}

function draftInput(pane: HTMLElement) {
  return within(pane).getByRole<HTMLTextAreaElement>("textbox", { name: copy.draft });
}

function enterDraft(pane: HTMLElement, body: string) {
  act(() => {
    fireEvent.input(draftInput(pane), { target: { value: body } });
  });
}

async function openGuide(pane: HTMLElement) {
  const view = within(pane);
  await act(async () => {
    view.getByRole("button", { name: copy.title }).click();
  });
  await view.findByText("2 of 3 files loaded");
  return view;
}

describe("pull request review guide", () => {
  it("keeps checks and Activity and omits the guide until the host supplies a port", () => {
    const pane = mountPane(pullRequest(successfulChecks(1)));
    expect(within(pane).queryByTestId("pr-review-guide")).toBeNull();
    expect(within(pane).getByTestId("pr-pane-check-row")).toBeTruthy();
    expect(activityHeader(pane)).toBeTruthy();
  });

  it("offers the change request link in chat when the forge cannot supply a guide", async () => {
    const port = makePort();
    port.getReviewGuide.mockRejectedValueOnce({ code: "unsupported" });
    const data = {
      ...pullRequest([]),
      forge: "gitea",
      url: "https://gitea.example.test/acme/widgets/pulls/42",
    };
    const pane = mountPane(data, NO_INSETS, {
      port,
      identity: { ...reviewIdentity, forge: "gitea", host: "gitea.example.test" },
    });
    const view = within(pane);
    await act(async () => {
      view.getByRole("button", { name: copy.title }).click();
    });
    expect(await view.findByText(copy.errorUnsupported)).toBeTruthy();
    press(view.getByRole("button", { name: i18n.t("workspace.git.pr.actions.addToChat") }));
    expect(
      container?.querySelector('[data-testid="composer-review-attachment-pill"]'),
    ).toBeTruthy();
    expect(
      useWorkspaceAttachmentsStore.getState().attachmentsByScope[reviewAttachmentScope],
    ).toEqual([
      expect.objectContaining({
        title: data.title,
        text: `${data.title}\n${data.url}`,
        url: data.url,
      }),
    ]);
    expect(port.publishReviewComment).not.toHaveBeenCalled();
  });

  it("publishes the selected stop after read-back and attaches that diff and draft to the composer", async () => {
    const port = makePort(makeGuide({ diffBaseSha: "merge-base-sha" }));
    const onCommentPublished = vi.fn();
    const completion = deferred<void>();
    port.publishReviewComment.mockReturnValueOnce(completion.promise);
    const pane = mountPane(pullRequest([]), NO_INSETS, {
      port,
      identity: reviewIdentity,
      expectedVersion: reviewVersion,
      onCommentPublished,
    });
    const view = await openGuide(pane);
    expect(port.getReviewGuide).toHaveBeenCalledWith({
      cwd: "/repo",
      identity: reviewIdentity,
      expectedVersion: reviewVersion,
    });
    expect(view.getAllByRole("button", { name: "src/review.ts" })).toHaveLength(1);
    expect(view.getByText(copy.partial)).toBeTruthy();
    expect(view.getByText("Files without patches: 1")).toBeTruthy();
    expect(view.getByText("+use new setup")).toBeTruthy();
    expect(view.getByText("Needs attention · Sensitive area · −5")).toBeTruthy();

    press(view.getByRole("button", { name: "Source changes · +23" }));
    expect(view.getByText("+verified new default")).toBeTruthy();
    expect(view.queryByText("+use new setup")).toBeNull();
    enterDraft(pane, "Please explain this default.");
    press(view.getByRole("button", { name: copy.addToChat }));
    expect(view.getByText(copy.attached)).toBeTruthy();
    expect(
      container?.querySelector('[data-testid="composer-review-attachment-pill"]'),
    ).toBeTruthy();
    const added = useWorkspaceAttachmentsStore.getState().attachmentsByScope[reviewAttachmentScope];
    expect(added).toEqual([
      expect.objectContaining({
        kind: "forge.change_request_review",
        text: expect.stringContaining(
          "+verified new default\n\nReview draft:\nPlease explain this default.",
        ),
      }),
    ]);
    expect(added?.[0]).toMatchObject({
      text: expect.stringContaining("Base: merge-base-sha"),
    });
    expect(port.publishReviewComment).not.toHaveBeenCalled();

    const button = view.getByRole("button", { name: copy.publish });
    press(button);
    press(button);
    expect(port.publishReviewComment).toHaveBeenCalledExactlyOnceWith({
      cwd: "/repo",
      identity: reviewIdentity,
      version: reviewVersion,
      stopId: "followup",
      body: "Please explain this default.",
      operationId: expect.any(String),
    });
    expect(onCommentPublished).not.toHaveBeenCalled();
    await act(async () => {
      completion.resolve();
    });
    expect(view.getByText(copy.published)).toBeTruthy();
    expect(draftInput(pane).value).toBe("");
    expect(onCommentPublished).toHaveBeenCalledWith(port.publishReviewComment.mock.calls[0][0]);
  });

  it("retains permission and uncertain drafts, including the original operation ID on refresh", async () => {
    const port = makePort();
    port.publishReviewComment
      .mockRejectedValueOnce({ code: "permission" })
      .mockRejectedValueOnce(new Error("connection closed"));
    const pane = mountPane(pullRequest([]), NO_INSETS, { port, identity: reviewIdentity });
    const view = await openGuide(pane);
    enterDraft(pane, "Keep this note.");
    press(view.getByRole("button", { name: copy.publish }));
    await view.findByText(copy.errorPermission);
    expect(draftInput(pane).value).toBe("Keep this note.");
    press(view.getByRole("button", { name: copy.publish }));
    await view.findByText(copy.errorUnknown);
    const uncertainId = port.publishReviewComment.mock.calls[1][0].operationId;
    expect(view.queryByRole("button", { name: copy.publish })).toBeNull();
    press(view.getByRole("button", { name: copy.refresh }));
    await view.findByRole("textbox", { name: copy.draft });
    expect(draftInput(pane).value).toBe("Keep this note.");
    expect(view.getByText(copy.errorUnknown)).toBeTruthy();
    expect(view.queryByRole("button", { name: copy.publish })).toBeNull();
    expect(port.publishReviewComment).toHaveBeenCalledTimes(2);
    const drafts = Object.values(useReviewDrafts.getState().scopes).flatMap(Object.values);
    expect(drafts[0].attempt?.operationId).toBe(uncertainId);
  });

  it("disables writes to expired guides and archives the draft after fetching another version", async () => {
    const port = makePort();
    port.getReviewGuide.mockResolvedValueOnce(makeGuide()).mockResolvedValueOnce(
      makeGuide({
        version: { ...reviewVersion, headSha: "head-2" },
      }),
    );
    port.publishReviewComment.mockRejectedValueOnce({ code: "expired" });
    const pane = mountPane(pullRequest([]), NO_INSETS, {
      port,
      identity: reviewIdentity,
      expectedVersion: reviewVersion,
    });
    const view = await openGuide(pane);
    enterDraft(pane, "Draft for the old head.");
    press(view.getByRole("button", { name: copy.publish }));
    await view.findAllByText(copy.errorExpired);
    expect(view.getByRole("button", { name: copy.publish }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    press(view.getByRole("button", { name: copy.refresh }));
    await view.findByRole("textbox", { name: copy.draft });
    expect(port.getReviewGuide).toHaveBeenLastCalledWith({
      cwd: "/repo",
      identity: reviewIdentity,
      refresh: true,
    });
    expect(draftInput(pane).value).toBe("");
    expect(view.getByText(copy.previousDrafts)).toBeTruthy();
    expect(view.getByText("Draft for the old head.")).toBeTruthy();
  });

  it("drops late guide and publication responses when the workspace and review change", async () => {
    const lateGuide = deferred<ReviewGuide>();
    const old = makePort();
    old.getReviewGuide.mockReturnValueOnce(lateGuide.promise);
    const data = pullRequest([]);
    const pane = mountPane(data, NO_INSETS, { port: old, identity: reviewIdentity });
    const view = within(pane);
    press(view.getByRole("button", { name: copy.title }));
    await expect.poll(() => old.getReviewGuide.mock.calls.length).toBe(1);

    const otherIdentity = { ...reviewIdentity, number: 43 };
    const otherData = { ...data, number: 43, url: "https://example.test/pull/43" };
    const next = makePort(makeGuide({ identity: otherIdentity }));
    const onCommentPublished = vi.fn();
    renderPane(
      otherData,
      NO_INSETS,
      { port: next, identity: otherIdentity, onCommentPublished },
      "/other",
    );
    await openGuide(pane);
    await act(async () => {
      lateGuide.resolve(makeGuide({ stops: [] }));
    });
    expect(view.getByText("+use new setup")).toBeTruthy();
    expect(old.getReviewViewed).not.toHaveBeenCalled();

    const pending = deferred<void>();
    next.publishReviewComment.mockReturnValueOnce(pending.promise);
    enterDraft(pane, "This belongs to PR 43.");
    press(view.getByRole("button", { name: copy.publish }));
    renderPane(data, NO_INSETS, { port: old, identity: reviewIdentity });
    await openGuide(pane);
    await act(async () => {
      pending.resolve();
    });
    expect(view.queryByText(copy.published)).toBeNull();
    expect(onCommentPublished).not.toHaveBeenCalled();
    expect(draftInput(pane).value).toBe("");
  });

  it("rejects a different guide head until the user explicitly refreshes", async () => {
    const port = makePort();
    const pane = mountPane(pullRequest([]), NO_INSETS, {
      port,
      identity: reviewIdentity,
      observedHeadSha: "other-head",
    });
    const view = within(pane);
    press(view.getByRole("button", { name: copy.title }));
    await view.findByText(copy.errorStale);
    expect(view.queryByText("+use new setup")).toBeNull();
    expect(port.getReviewViewed).not.toHaveBeenCalled();
    press(view.getByRole("button", { name: copy.refresh }));
    await view.findByText("+use new setup");
  });

  it("keeps authority-confirmed viewed state on remote failures and leaves missing rows unknown", async () => {
    const port = makePort();
    port.getReviewViewed.mockResolvedValueOnce({
      entries: [{ path: "src/review.ts", state: "viewed" }],
      hasMore: true,
      viewerId: "account-a",
    });
    port.setReviewViewed
      .mockRejectedValueOnce({ code: "permission" })
      .mockResolvedValueOnce({ path: "src/review.ts", state: "dismissed" });
    const pane = mountPane(pullRequest([]), NO_INSETS, { port, identity: reviewIdentity });
    const view = await openGuide(pane);
    const unview = await view.findByRole("button", { name: copy.markUnviewed });
    expect(view.getByText(copy.viewedUnknown)).toBeTruthy();
    await act(async () => {
      unview.click();
    });
    await view.findByText(copy.errorPermission);
    expect(view.getByText(copy.viewed)).toBeTruthy();
    expect(view.queryByText(copy.viewedLocal)).toBeNull();
    await act(async () => {
      view.getByRole("button", { name: copy.markUnviewed }).click();
    });
    expect(port.setReviewViewed).toHaveBeenCalledTimes(2);
    await view.findByText(copy.dismissed);
    expect(port.setReviewViewed).toHaveBeenLastCalledWith({
      cwd: "/repo",
      identity: reviewIdentity,
      version: reviewVersion,
      path: "src/review.ts",
      viewed: false,
      expectedViewerId: "account-a",
    });
  });

  it("keeps local viewed status separate from the forge and attaches a draft for a stop without a patch", async () => {
    const identity = { ...reviewIdentity, number: 95 };
    const port = makePort(makeGuide({ identity, commentMode: "chat", viewedMode: "local" }));
    const data = { ...pullRequest([]), number: 95, url: "https://example.test/pull/95" };
    const pane = mountPane(data, NO_INSETS, { port, identity });
    const view = await openGuide(pane);
    const row = view.getByRole("button", { name: "src/review.ts" }).parentElement;
    if (!row) throw new Error("The review file row did not render");
    await within(row).findByText(copy.unviewed);
    const mark = within(row).getByRole("button", { name: copy.markViewed });
    await act(async () => {
      mark.click();
    });
    await view.findByText(copy.viewed);
    expect(view.getByText(copy.viewedLocal)).toBeTruthy();
    expect(port.getReviewViewed).not.toHaveBeenCalled();
    expect(port.setReviewViewed).not.toHaveBeenCalled();

    press(view.getByRole("button", { name: "assets/binary" }));
    expect(view.getByText(copy.noInlineLocation)).toBeTruthy();
    expect(view.queryByRole("button", { name: copy.publish })).toBeNull();
    enterDraft(pane, "Check this asset manually.");
    press(view.getByRole("button", { name: copy.addToChat }));
    const added = useWorkspaceAttachmentsStore.getState().attachmentsByScope[reviewAttachmentScope];
    expect(added?.[0]).toMatchObject({
      title: "assets/binary",
      text: expect.stringContaining(
        "No patch available for this stop.\n\nReview draft:\nCheck this asset manually.",
      ),
    });
  });
});
