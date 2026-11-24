import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ToastApiProvider } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import { ChangesSurface } from "./diff-pane";
import { checkoutDiffQueryKey, checkoutStatusQueryKey } from "./query-keys";
import { resetWorkingDiffComparisons, selectCheckpointDiff } from "./working-diff-comparison";

vi.mock("lucide-react-native", async (importOriginal) => {
  const icons = await importOriginal<typeof import("lucide-react-native")>();
  const icon = icons.FileText;
  return {
    ...icons,
    AlignJustify: icon,
    CopyPlus: icon,
    Diff: icon,
    FilePlus: icon,
    FileWarning: icon,
    FolderMinus: icon,
    ListChevronsDownUp: icon,
    ListChevronsUpDown: icon,
    Pilcrow: icon,
    Send: icon,
    SquareDot: icon,
    SquareMinus: icon,
    SquarePlus: icon,
    WrapText: icon,
  };
});

void i18n;
const scope = { serverId: "history-host", workspaceId: "worktree", cwd: "/repo" };
const target = { agentId: "agent", messageId: "message" };
const insets = { top: 0, bottom: 0, left: 0, right: 0 };
const toast = { show: () => () => {}, error: () => {}, copied: () => {} };
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  useSessionStore.getState().clearSession(scope.serverId);
  resetWorkingDiffComparisons();
  vi.unstubAllGlobals();
});

function file(path: string): ParsedDiffFile {
  return { path, isNew: true, isDeleted: false, additions: 1, deletions: 0, hunks: [] };
}

test("compares the selected turn and frozen baseline, then returns to live changes", async () => {
  const getAgentRewindCheckpointDiff = vi.fn<DaemonClient["getAgentRewindCheckpointDiff"]>(
    async ({ agentId, range }) => ({
      agentId,
      requestId: range,
      ok: true,
      error: null,
      result:
        range === "turn"
          ? {
              kind: "ready",
              files: [file("turn.txt"), file("external.txt")],
              stagedFiles: [file("staging-only.txt")],
              diffTooLarge: false,
              attribution: "unknown",
            }
          : { kind: "unavailable", reason: "missing" },
    }),
  );
  const client = Object.assign(
    new DaemonClient({ url: "ws://unused.test", clientId: scope.serverId }),
    { getAgentRewindCheckpointDiff },
  );
  useSessionStore.getState().initializeSession(scope.serverId, client);
  useSessionStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [scope.serverId]: {
        ...state.sessions[scope.serverId],
        serverInfo: {
          serverId: scope.serverId,
          hostname: null,
          version: null,
          features: { rewindCheckpoints: true, checkoutDiscardChanges: true },
        },
      },
    },
  }));
  const query = new QueryClient();
  query.setQueryData(checkoutStatusQueryKey(scope.serverId, scope.cwd), {
    isGit: true,
    isDirty: true,
    currentBranch: "feature",
    baseRef: "main",
  });
  query.setQueryData(checkoutDiffQueryKey(scope.serverId, scope.cwd, "uncommitted"), {
    requestId: "live",
    cwd: scope.cwd,
    error: null,
    files: [file("live.txt")],
  });
  selectCheckpointDiff({ ...scope, selection: { target, range: "turn" } });
  const container = document.createElement("div");
  Object.assign(container.style, { width: "800px", height: "600px", display: "flex" });
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={query}>
        <ToastApiProvider api={toast}>
          <SafeAreaInsetsContext.Provider value={insets}>
            <ChangesSurface {...scope} presentation="tree" />
          </SafeAreaInsetsContext.Provider>
        </ToastApiProvider>
      </QueryClientProvider>,
    ),
  );
  dispose = () => {
    act(() => root.unmount());
    container.remove();
    query.clear();
  };

  await expect.element(page.getByTestId("changes-checkpoint-attribution")).toBeVisible();
  await expect.element(page.getByText("external.txt", { exact: true })).toBeVisible();
  expect(getAgentRewindCheckpointDiff).toHaveBeenCalledWith({ ...target, range: "turn" });
  await userEvent.click(page.getByTestId("changes-checkpoint-layer-staged"));
  await expect.element(page.getByText("staging-only.txt", { exact: true })).toBeVisible();
  await expect.element(page.getByText("external.txt", { exact: true })).not.toBeInTheDocument();
  await userEvent.click(page.getByTestId("changes-checkpoint-layer-worktree"));
  await expect.element(page.getByText("external.txt", { exact: true })).toBeVisible();
  await userEvent.click(page.getByTestId("changes-diff-status-trigger"));
  await userEvent.click(page.getByTestId("changes-diff-mode-baseline"));
  await expect
    .element(page.getByText("This comparison is unavailable because a checkpoint is missing."))
    .toBeVisible();
  expect(getAgentRewindCheckpointDiff).toHaveBeenCalledWith({ ...target, range: "baseline" });
  await userEvent.click(page.getByTestId("changes-diff-status-trigger"));
  await userEvent.click(page.getByTestId("changes-diff-mode-uncommitted"));
  const liveFile = page.getByText("live.txt", { exact: true });
  await expect.element(liveFile).toBeVisible();
  await expect.element(page.getByTestId("changes-checkpoint-attribution")).not.toBeInTheDocument();
  await userEvent.click(liveFile, { button: "right" });
  await expect.element(page.getByText("Discard changes", { exact: true })).toBeVisible();
});
