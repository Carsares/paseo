import React, { act } from "react";
import { PortalProvider } from "@gorhom/portal";
import { NavigationContext } from "expo-router/react-navigation";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { within } from "@testing-library/dom";
import type { DiffState } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  ParsedDiffFile,
  WorkspaceDurableItem,
  WorkspaceTodoItem,
} from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { SidebarWorkspaceList } from "@/components/sidebar-workspace-list";
import { ToastProvider } from "@/contexts/toast-context";
import { durableItemsQueryKey } from "@/durable-items/queries";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { i18n } from "@/i18n/i18next";
import { defaultHostAppearance } from "@/hosts/appearance";
import {
  getHostRuntimeStore,
  type HostRuntimeConnectionStatus,
  type HostRuntimeSnapshot,
} from "@/runtime/host-runtime";
import {
  SheetPaneHostProvider,
  type SheetPaneHost,
  WorkspaceSheetSurface,
} from "@/screens/workspace/sheet-pane";
import { ActiveWorkspaceSheetProvider } from "@/screens/workspace/sheet-pane/active-workspace";
import { SheetTabs } from "@/screens/workspace/sheet-tabs";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import { TodoEditorSheet } from "@/todos/todo-editor-sheet";
import type { HostProfile } from "@/types/host-connection";

vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => window.innerWidth < 600,
}));

vi.mock("@gorhom/bottom-sheet", async (importOriginal) => {
  const [actual, { Portal }, { createElement, forwardRef, useImperativeHandle }] =
    await Promise.all([
      importOriginal<typeof import("@gorhom/bottom-sheet")>(),
      import("@gorhom/portal"),
      import("react"),
    ]);
  const noop = () => {};
  return {
    ...actual,
    BottomSheetModal: forwardRef(({ children }: { children: React.ReactNode }, ref) => {
      useImperativeHandle(ref, () => ({ present: noop }), []);
      return createElement(Portal, null, createElement("div", null, children));
    }),
    useBottomSheetGestureHandlers: () => ({
      handlePanGestureHandler: {
        handleOnStart: noop,
        handleOnChange: noop,
        handleOnEnd: noop,
        handleOnFinalize: noop,
      },
    }),
  };
});

vi.mock("@/components/ui/isolated-bottom-sheet-modal/visible-frame", () => ({
  SheetVisibleFrame: ({ children }: { children: React.ReactNode }) => children,
}));

type Client = Pick<
  DaemonClient,
  | "listWorkspaceDurableItems"
  | "decideWorkspaceDurableItem"
  | "readFile"
  | "readDiff"
  | "checkoutGitWorkingTreeGet"
  | "listWorkspaceTodos"
  | "upsertWorkspaceTodo"
>;
const snapshots = new Map<
  string,
  { connectionStatus: HostRuntimeConnectionStatus; client: Client }
>();
let hosts: HostProfile[];

const pending = {
  workspaceId: "parked",
  requestId: "shared-request-id",
  sourceAgentId: "agent",
  sourceTurnId: "turn",
  kind: "acceptance",
  title: "Accept trace",
  evidence: [{ type: "file", path: "startup-trace.md", fingerprint: "snapshotted-trace-hash" }],
  createdAt: "2026-01-01T00:00:00Z",
  revision: 0,
  status: "pending",
} satisfies WorkspaceDurableItem;

const completed = {
  id: "agent",
  status: "idle",
  title: "Finished conclusion",
  workspaceId: "parked",
  parentAgentId: null,
  archivedAt: null,
  background: false,
  requiresAttention: true,
  attentionReason: "finished",
  attentionTimestamp: new Date(pending.createdAt),
  updatedAt: new Date(pending.createdAt),
} as unknown as Agent;

const inactiveWorkspace = {
  id: "parked",
  name: "Dormant workspace",
  projectDisplayName: "Paseo",
  archivingAt: null,
  parkedAt: pending.createdAt,
  workspaceDirectory: "/workspaces/parked",
} as WorkspaceDescriptor;

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useSidebarViewStore.getState().setGroupMode(useSidebarViewStore.getInitialState().groupMode);
  hosts = [];
  vi.spyOn(getHostRuntimeStore(), "getHosts").mockImplementation(() => hosts);
  vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockImplementation(
    (id) => (snapshots.get(id) as HostRuntimeSnapshot | undefined) ?? null,
  );
  await i18n.changeLanguage("en");
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  container.style.width = "300px";
  container.style.height = "600px";
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  useTopicStreamViewStore.getState().closeTodoEditor();
  queryClient.clear();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  snapshots.clear();
  useSessionStore.setState({ sessions: {} });
});

function seed(
  serverId: string,
  listItems: WorkspaceDurableItem[],
  options: { capable?: boolean; withConclusion?: boolean; todo?: WorkspaceTodoItem } = {},
) {
  const list = vi.fn<Client["listWorkspaceDurableItems"]>(
    async ({ workspaceId, statusFilter }) => ({
      requestId: "rpc",
      items: listItems.filter(
        (item) =>
          (!workspaceId || item.workspaceId === workspaceId) &&
          (!statusFilter || item.status === statusFilter),
      ),
      nextCursor: null,
      error: null,
    }),
  );
  const decide = vi.fn<Client["decideWorkspaceDurableItem"]>();
  const readFile = vi.fn<Client["readFile"]>();
  const readDiff = vi.fn<Client["readDiff"]>();
  const workingTree = vi
    .fn<Client["checkoutGitWorkingTreeGet"]>()
    .mockRejectedValue(new Error("Host does not support checkoutGitStagingV1"));
  const listTodos = vi.fn<Client["listWorkspaceTodos"]>(async () => ({
    requestId: "todo-list",
    items: options.todo ? [options.todo] : [],
    error: null,
  }));
  const upsertTodo = vi.fn<Client["upsertWorkspaceTodo"]>(async (input) => ({
    requestId: "todo-save",
    item: options.todo ? { ...options.todo, ...input, revision: options.todo.revision + 1 } : null,
    error: null,
  }));
  snapshots.set(serverId, {
    connectionStatus: "online",
    client: {
      listWorkspaceDurableItems: list,
      decideWorkspaceDurableItem: decide,
      readFile,
      readDiff,
      checkoutGitWorkingTreeGet: workingTree,
      listWorkspaceTodos: listTodos,
      upsertWorkspaceTodo: upsertTodo,
    },
  });
  hosts = [
    ...hosts,
    {
      serverId,
      label: serverId,
      appearance: defaultHostAppearance(),
      lifecycle: {},
      connections: [],
      preferredConnectionId: null,
      createdAt: pending.createdAt,
      updatedAt: pending.createdAt,
    },
  ];
  act(() => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [serverId]: {
          serverInfo: {
            features: {
              workspaceDurableItemsV1: options.capable ?? true,
              diffSubscription: true,
              workspaceTodos: Boolean(options.todo),
            },
          },
          agents: options.withConclusion ? new Map([[completed.id, completed]]) : new Map(),
          workspaces: new Map([[inactiveWorkspace.id, inactiveWorkspace]]),
        } as never,
      },
    }));
  });
  return { list, decide, readFile, readDiff, workingTree, upsertTodo };
}

const toggleProject = () => {};
const emptySidebar = {
  workspaceGroups: [],
  projectIconTargets: [],
  pinnedGroups: { pinnedChats: [], unpinnedProjects: [] },
  projects: [],
  hasProjectsBeforeFilter: true,
  hasActiveProjectFilter: true,
  workspaceEntriesByKey: new Map(),
  collapsedProjectKeys: new Set<string>(),
  onToggleProjectCollapsed: toggleProject,
  shortcutIndexByWorkspaceKey: new Map<string, number>(),
} satisfies Omit<React.ComponentProps<typeof SidebarWorkspaceList>, "groupMode">;

function SidebarUnderTest() {
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  return <SidebarWorkspaceList {...emptySidebar} groupMode={groupMode} />;
}

type Navigation = NonNullable<React.ContextType<typeof NavigationContext>>;
const focusedNavigation = {
  isFocused: () => true,
  addListener: () => () => {},
} satisfies Pick<Navigation, "isFocused" | "addListener">;
const navigation = focusedNavigation as unknown as Navigation;
async function closeTab() {}

const previousPage = {
  key: "existing-workspace-page",
  title: "Existing workspace page",
  render: () => <div>Workspace sheet contents</div>,
};

function AppSheetTestProviders({ children }: { children: React.ReactNode }) {
  return (
    <GestureHandlerRootView>
      <SafeAreaProvider>
        <PortalProvider>
          <ActiveWorkspaceSheetProvider>{children}</ActiveWorkspaceSheetProvider>
        </PortalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function SidebarWithWorkspaceSheet({
  host,
  children,
}: {
  host: SheetPaneHost;
  children: React.ReactNode;
}) {
  const workspace = (
    <NavigationContext.Provider value={navigation}>
      <DiffDocumentWorkspaceCacheProvider>
        <SheetPaneHostProvider value={host}>
          {host.isWorkspaceFocused ? <WorkspaceSheetSurface page={previousPage} /> : null}
          <SheetTabs onCloseTab={closeTab} />
        </SheetPaneHostProvider>
      </DiffDocumentWorkspaceCacheProvider>
    </NavigationContext.Provider>
  );
  return (
    <AppSheetTestProviders>
      {children}
      {workspace}
    </AppSheetTestProviders>
  );
}

function renderSidebar(active = true, sheetHost?: SheetPaneHost) {
  const sidebar = (
    <RetainedPanelActivity active={active}>
      <ToastProvider>
        <SidebarUnderTest />
      </ToastProvider>
    </RetainedPanelActivity>
  );
  const content = sheetHost ? (
    <SidebarWithWorkspaceSheet host={sheetHost}>{sidebar}</SidebarWithWorkspaceSheet>
  ) : (
    sidebar
  );
  act(() => root.render(<QueryClientProvider client={queryClient}>{content}</QueryClientProvider>));
  return within(container);
}

it("edits a different workspace's todo from the global sidebar while a terminal is visible", async () => {
  await page.viewport(1000, 720);
  const todo = {
    todoId: "global-todo",
    workspaceId: "parked",
    title: "Review tomorrow",
    status: "pending",
    checklist: [],
    dueAt: "2026-11-27T10:20:35.200Z",
    remindBeforeMinutes: 45,
    snoozedUntil: "2026-11-27T11:20:35.200Z",
    lastDueNotifiedAt: null,
    source: null,
    assignedAgentId: null,
    revision: 4,
    createdAt: pending.createdAt,
    updatedAt: pending.createdAt,
    completedAt: null,
  } satisfies WorkspaceTodoItem;
  const otherHost = seed("terminal-host", []);
  const todoHost = seed("todo-host", [pending], { todo });
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <AppSheetTestProviders>
          <ToastProvider>
            <SidebarUnderTest />
            <div data-testid="terminal-pane">Terminal in another workspace</div>
            <TodoEditorSheet />
          </ToastProvider>
        </AppSheetTestProviders>
      </QueryClientProvider>,
    ),
  );

  await page.getByRole("button", { name: "Review tomorrow, Dormant workspace, todo-host" }).click();
  await expect.element(page.getByTestId("todo-editor-sheet")).toBeVisible();
  expect(page.getByTestId("todo-editor-sheet").all()).toHaveLength(1);
  await expect.element(page.getByTestId("terminal-pane")).toBeVisible();
  const title = page.getByTestId("todo-editor-title-input");
  const due = page.getByTestId("todo-editor-due-custom-input");
  const originalDueInput = (due.element() as HTMLInputElement).value;
  expect(originalDueInput).toMatch(/^2026-11-27 \d{2}:20$/);
  await title.fill("Updated title");
  await due.fill("2026-02-30 09:00");
  await page.getByTestId("todo-editor-save").click();
  await expect.element(page.getByTestId("todo-editor-error")).toBeVisible();
  await expect.element(due).toHaveValue("2026-02-30 09:00");
  expect(todoHost.upsertTodo).not.toHaveBeenCalled();

  await due.fill(originalDueInput);
  await page.getByTestId("todo-editor-save").click();
  await expect.element(page.getByTestId("todo-editor-sheet")).not.toBeInTheDocument();
  expect(todoHost.upsertTodo).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "parked",
    todoId: todo.todoId,
    expectedRevision: 4,
    title: "Updated title",
    checklist: [],
    source: null,
  });
  expect(otherHost.upsertTodo).not.toHaveBeenCalled();
  expect(queryClient.getQueryData(["workspace-todos", "todo-host", null])).toMatchObject([
    {
      title: "Updated title",
      dueAt: todo.dueAt,
      remindBeforeMinutes: 45,
      snoozedUntil: todo.snoozedUntil,
    },
  ]);
});

it("keeps a single inbox above unread conclusions when switching the default sidebar grouping", async () => {
  const host = seed("host-a", [pending], { withConclusion: true });
  const view = renderSidebar();
  await view.findByText("Needs my action 1");
  const inbox = view.getByTestId("sidebar-durable-items-section");
  const unread = view.getByTestId("sidebar-unread-conclusions-section");
  expect(view.getByTestId("sidebar-project-workspace-list-scroll").contains(inbox)).toBe(true);
  expect(inbox.compareDocumentPosition(unread)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(view.getByTestId("sidebar-filter-empty-state")).toBeVisible();
  await act(async () => view.getByTestId("sidebar-durable-item-row").click());
  const card = view.getByTestId("durable-item-card");

  for (const [mode, scroll] of [
    ["status", "sidebar-status-list-scroll"],
    ["project", "sidebar-project-workspace-list-scroll"],
  ] as const) {
    await act(async () => useSidebarViewStore.getState().setGroupMode(mode));
    expect(view.getByTestId(scroll).contains(inbox)).toBe(true);
    expect(view.getAllByTestId("sidebar-durable-items-section")).toEqual([inbox]);
    expect(view.getAllByTestId("sidebar-unread-conclusions-section")).toEqual([unread]);
    expect(inbox.compareDocumentPosition(unread)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(view.getByTestId("durable-item-card")).toBe(card);
    expect(view.getByTestId("sidebar-filter-empty-state")).toBeVisible();
  }
  expect(
    host.list.mock.calls.filter(([request]) => request.statusFilter === "pending"),
  ).toHaveLength(1);
});

it("counts requests across hosts above unread conclusions and reads a parked workspace without actions", async () => {
  const first = seed("host-a", [pending], { withConclusion: true });
  const second = seed("host-b", [pending]);
  const legacy = seed("old-host", [pending], { capable: false });
  const view = renderSidebar(false);
  expect(first.list).not.toHaveBeenCalled();
  expect(second.list).not.toHaveBeenCalled();
  renderSidebar();

  const header = await view.findByText("Needs my action 2");
  const conclusion = view.getByText("Finished conclusion");
  expect(
    header.compareDocumentPosition(conclusion) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(view.getAllByTestId("sidebar-durable-item-row")).toHaveLength(2);
  expect(legacy.list).not.toHaveBeenCalled();
  act(() => view.getByRole("button", { name: "Accept trace, Dormant workspace, host-b" }).click());
  const card = within(view.getByTestId("durable-item-card"));
  act(() => card.getByRole("button", { name: "startup-trace.md" }).click());
  await expect.element(card.getByText("snapshotted-trace-hash")).toBeVisible();
  await expect.element(card.getByRole("button", { name: "Accept" })).toBeEnabled();
  expect(second.list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "parked" }));
  expect(first.decide).not.toHaveBeenCalled();
  expect(second.decide).not.toHaveBeenCalled();
});

const evidenceRepo = "/workspaces/parked/repo";

function readyDiff(files: ParsedDiffFile[], diffTooLarge = false): DiffState {
  return {
    phase: "ready",
    revision: 1,
    resolved: { baseSha: "", headSha: "", mergeBaseSha: "" },
    files,
    diffTooLarge,
  };
}

function diffFile(path: string, before: string, after: string): ParsedDiffFile {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions: 1,
    deletions: 1,
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: [
          { type: "remove", content: before },
          { type: "add", content: after },
        ],
      },
    ],
  };
}

it("shows a staged-only change on a host with diff subscriptions and no staging capability", async () => {
  const host = seed("rollback-host", [
    {
      ...pending,
      evidence: [
        {
          type: "git",
          repoRoot: evidenceRepo,
          path: "boot.ts",
          headSha: "recorded-head",
          blobOrIndexFingerprint: "recorded-git-fingerprint",
        },
      ],
    },
  ]);
  host.readDiff.mockImplementation(async ({ base, head }) =>
    base.kind === "rev" && base.rev === "HEAD" && head.kind === "index"
      ? readyDiff([diffFile("boot.ts", "A", "B")])
      : readyDiff([]),
  );
  const view = renderSidebar();
  const row = await view.findByTestId("sidebar-durable-item-row");
  await act(async () => row.click());
  await act(async () => view.getByRole("button", { name: "boot.ts" }).click());
  const staged = within(view.getByTestId("durable-item-staged-preview"));
  const unstaged = within(view.getByTestId("durable-item-unstaged-preview"));
  expect(await staged.findByText(/-A.*\+B/)).toBeVisible();
  expect(await unstaged.findByText("No changes for this file in this comparison.")).toBeVisible();
  expect(host.workingTree).not.toHaveBeenCalled();
  expect(host.readDiff).toHaveBeenCalledWith({
    cwd: evidenceRepo,
    base: { kind: "rev", rev: "HEAD" },
    head: { kind: "index" },
  });
  expect(host.readDiff).toHaveBeenCalledWith({
    cwd: evidenceRepo,
    base: { kind: "index" },
    head: { kind: "worktree" },
  });
});

it("opens current file contents and both Git layers when the worktree matches HEAD", async () => {
  const item = {
    ...pending,
    evidence: [
      ...pending.evidence,
      {
        type: "git",
        repoRoot: "/workspaces/parked/repo",
        path: "boot.ts",
        headSha: "recorded-head",
        blobOrIndexFingerprint: "recorded-git-fingerprint",
      },
      {
        type: "git",
        repoRoot: "/outside",
        path: "unrelated.ts",
        headSha: "other-head",
        blobOrIndexFingerprint: "other-fingerprint",
      },
    ],
  } satisfies WorkspaceDurableItem;
  const host = seed("host-a", [item]);
  const bytes = new TextEncoder().encode("Current trace content");
  host.readFile.mockResolvedValue({
    bytes,
    mime: "text/plain",
    size: bytes.length,
    path: "startup-trace.md",
    kind: "text",
    modifiedAt: pending.createdAt,
  });
  // HEAD and the worktree both contain A. A net diff would miss both changes.
  host.readDiff.mockImplementation(async ({ base, head }) => {
    if (base.kind === "rev" && base.rev === "HEAD" && head.kind === "index") {
      return readyDiff([diffFile("noise.ts", "ignored", "ignore"), diffFile("boot.ts", "A", "B")]);
    }
    if (base.kind === "index" && head.kind === "worktree") {
      return readyDiff([diffFile("boot.ts", "B", "A")]);
    }
    return readyDiff([]);
  });
  const view = renderSidebar();
  const row = await view.findByTestId("sidebar-durable-item-row");
  act(() => row.click());
  const card = within(view.getByTestId("durable-item-card"));
  expect(host.readFile).not.toHaveBeenCalled();
  expect(host.readDiff).not.toHaveBeenCalled();
  expect(host.workingTree).not.toHaveBeenCalled();
  act(() => card.getByRole("button", { name: "startup-trace.md" }).click());
  await expect.element(await card.findByText("Current trace content")).toBeVisible();
  expect(card.getByText("Recorded at submission")).toBeVisible();
  expect(card.getByText("snapshotted-trace-hash")).toBeVisible();
  expect(card.getByText("Current file contents")).toBeVisible();
  expect(host.readFile).toHaveBeenCalledWith(
    "/workspaces/parked",
    "startup-trace.md",
    undefined,
    65_536,
  );

  act(() => card.getByRole("button", { name: "boot.ts" }).click());
  const staged = within(card.getByTestId("durable-item-staged-preview"));
  const unstaged = within(card.getByTestId("durable-item-unstaged-preview"));
  await expect.element(await staged.findByText(/-A.*\+B/)).toBeVisible();
  await expect.element(await unstaged.findByText(/-B.*\+A/)).toBeVisible();
  expect(staged.getByText("Current staged diff (HEAD to index)")).toBeVisible();
  expect(unstaged.getByText("Current unstaged diff (index to working tree)")).toBeVisible();
  expect(card.queryByText(/-ignored/)).toBeNull();
  expect(card.getByText("recorded-head")).toBeVisible();
  expect(card.getByText("recorded-git-fingerprint")).toBeVisible();

  act(() => card.getByRole("button", { name: "unrelated.ts" }).click());
  expect(card.getAllByText("Could not read the current evidence.")).toHaveLength(2);
  expect(host.workingTree).not.toHaveBeenCalled();
  expect(host.readDiff).toHaveBeenCalledTimes(2);
  expect(host.decide).not.toHaveBeenCalled();
});

it("reads staged changes from unborn HEAD and distinguishes binary and empty files from no changes", async () => {
  const host = seed("host-a", [
    {
      ...pending,
      evidence: [
        {
          type: "git",
          repoRoot: evidenceRepo,
          path: "boot.bin",
          headSha: null,
          blobOrIndexFingerprint: "recorded",
        },
        {
          type: "git",
          repoRoot: evidenceRepo,
          path: "empty.txt",
          headSha: null,
          blobOrIndexFingerprint: "recorded-empty-file",
        },
      ],
    },
  ]);
  host.readDiff.mockImplementation(async ({ base, head }) => {
    if (base.kind === "rev" && base.rev === "HEAD" && head.kind === "index") {
      return readyDiff([
        { ...diffFile("boot.bin", "", ""), status: "binary", hunks: [] },
        { path: "empty.txt", isNew: true, isDeleted: false, additions: 0, deletions: 0, hunks: [] },
      ]);
    }
    return readyDiff([]);
  });
  const view = renderSidebar();
  const row = await view.findByTestId("sidebar-durable-item-row");
  await act(async () => row.click());
  await act(async () => view.getByRole("button", { name: "boot.bin" }).click());
  const staged = within(view.getByTestId("durable-item-staged-preview"));
  const unstaged = within(view.getByTestId("durable-item-unstaged-preview"));
  expect(await staged.findByText("No text preview is available for this file.")).toBeVisible();
  expect(await unstaged.findByText("No changes for this file in this comparison.")).toBeVisible();
  expect(view.getByText("No commit")).toBeVisible();

  await act(async () => view.getByRole("button", { name: "empty.txt" }).click());
  const stagedEmpty = within(view.getByTestId("durable-item-staged-preview"));
  expect(await stagedEmpty.findByText("This file changed without any text changes.")).toBeVisible();
  expect(host.workingTree).not.toHaveBeenCalled();
});

it("keeps an oversized Git layer separate from a read error and clears both when offline", async () => {
  const host = seed("host-a", [
    {
      ...pending,
      evidence: [
        {
          type: "git",
          repoRoot: evidenceRepo,
          path: "boot.ts",
          headSha: "recorded-head",
          blobOrIndexFingerprint: "recorded",
        },
      ],
    },
  ]);
  host.readDiff.mockImplementation(async ({ head }) =>
    head.kind === "index"
      ? readyDiff([{ ...diffFile("boot.ts", "", ""), status: "too_large", hunks: [] }], true)
      : { phase: "error", revision: 0, error: { code: "UNKNOWN", message: "Read failed" } },
  );
  const view = renderSidebar();
  const row = await view.findByTestId("sidebar-durable-item-row");
  await act(async () => row.click());
  await act(async () => view.getByRole("button", { name: "boot.ts" }).click());
  const staged = within(view.getByTestId("durable-item-staged-preview"));
  const unstaged = within(view.getByTestId("durable-item-unstaged-preview"));
  expect(await staged.findByText("This diff is too large to preview.")).toBeVisible();
  expect(await unstaged.findByText("Could not read the current evidence.")).toBeVisible();

  snapshots.get("host-a")!.connectionStatus = "offline";
  renderSidebar();
  expect(await staged.findByText("This host is offline.")).toBeVisible();
  expect(await unstaged.findByText("This host is offline.")).toBeVisible();
  expect(host.readDiff).toHaveBeenCalledTimes(2);
});

it("blocks approval after stale evidence, then restores the winning decision from another device", async () => {
  const items: WorkspaceDurableItem[] = [pending];
  const { decide } = seed("host-a", items);
  const view = renderSidebar();
  const row = await view.findByTestId("sidebar-durable-item-row");
  act(() => row.click());
  const card = within(view.getByTestId("durable-item-card"));
  await expect.element(card.getByRole("button", { name: "Accept" })).toBeEnabled();
  const reply = {
    requestId: "rpc",
    workspaceId: pending.workspaceId,
    durableItemRequestId: pending.requestId,
  };
  decide.mockResolvedValueOnce({
    ...reply,
    item: null,
    error: "Stale",
    errorCode: "DURABLE_ITEM_STALE_EVIDENCE",
  });
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await card.findByText("The evidence has changed. Ask for an updated request before approving.");
  await expect.element(card.getByRole("button", { name: "Accept" })).toBeDisabled();
  await expect.element(card.getByRole("button", { name: "Reject" })).toBeEnabled();

  const winningItem: WorkspaceDurableItem = {
    ...pending,
    status: "decided",
    revision: 1,
    decision: "request_changes",
    decidedAt: pending.createdAt,
  };
  decide.mockImplementationOnce(async () => {
    items[0] = winningItem;
    return { ...reply, item: winningItem, error: "Conflict" };
  });
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await card.findByText("Changes requested");
  await expect.element(card.getByText("This request changed on another device.")).toBeVisible();
  await expect.element(view.getByText("Needs my action 0")).toBeVisible();
  expect(view.queryByTestId("sidebar-durable-item-row")).toBeNull();
  expect(decide).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ expectedRevision: 0, decision: "reject" }),
  );
});

it("retains offline rows, blocks missing evidence, and reconciles expiration on the next read", async () => {
  const items: WorkspaceDurableItem[] = [{ ...pending, evidence: [] }];
  const { decide } = seed("host-a", items);
  const view = renderSidebar();
  const row = await view.findByTestId("sidebar-durable-item-row");
  act(() => row.click());
  const card = within(view.getByTestId("durable-item-card"));
  await card.findByText("Approval requires complete evidence.");
  await expect.element(card.getByRole("button", { name: "Accept" })).toBeDisabled();

  snapshots.get("host-a")!.connectionStatus = "offline";
  renderSidebar();
  await expect
    .element(view.getByText("Some hosts are unavailable. The count may be out of date."))
    .toBeVisible();
  await expect.element(card.getByRole("button", { name: "Reject" })).toBeDisabled();
  await expect.element(card.getByText("This host is offline.")).toBeVisible();
  expect(decide).not.toHaveBeenCalled();

  items[0] = { ...pending, status: "expired", revision: 1, expiredAt: pending.createdAt };
  snapshots.get("host-a")!.connectionStatus = "online";
  renderSidebar();
  await queryClient.invalidateQueries({ queryKey: durableItemsQueryKey("host-a", "parked") });
  await card.findByText("This request has expired.");
  expect(card.queryByRole("button", { name: "Accept" })).toBeNull();
  expect(decide).not.toHaveBeenCalled();
});

it("opens compact sidebar evidence in its sibling workspace sheet and returns to the previous page", async () => {
  await page.viewport(390, 720);
  const origin = seed("evidence-host", [pending]);
  const active = seed("active-host", []);
  const bytes = new TextEncoder().encode("Evidence from the parked workspace");
  origin.readFile.mockResolvedValue({
    bytes,
    mime: "text/plain",
    size: bytes.length,
    path: "startup-trace.md",
    kind: "text",
    modifiedAt: pending.createdAt,
  });
  const host: SheetPaneHost = {
    workspaceKey: "active-host:focused",
    serverId: "active-host",
    workspaceId: "focused",
    isWorkspaceFocused: false,
    buildContent: () => {
      throw new Error("Expected workspace sheet pages");
    },
  };
  const view = renderSidebar(true, host);
  const row = await view.findByTestId("sidebar-durable-item-row");
  await act(async () => row.click());
  const card = within(view.getByTestId("durable-item-card"));
  const evidence = card.getByRole("button", { name: "startup-trace.md" });
  await act(async () => evidence.click());
  expect(await card.findByText("Evidence from the parked workspace")).toBeVisible();

  await act(async () => evidence.click());
  renderSidebar(true, { ...host, isWorkspaceFocused: true });
  const previous = page.getByRole("dialog", {
    name: "Existing workspace page",
    includeHidden: true,
  });
  await expect.element(previous).toBeVisible();
  await act(async () => evidence.click());

  const sheet = page.getByRole("dialog", { name: "startup-trace.md" });
  await expect.element(sheet.getByText("Evidence from the parked workspace")).toBeVisible();
  await expect.element(previous).not.toBeVisible();
  expect(card.queryByTestId("durable-item-evidence-details")).toBeNull();

  // Replay the sidebar click to exercise a duplicate key in the real workspace stack.
  await act(async () => evidence.click());
  await expect.element(sheet.getByText("Evidence from the parked workspace")).toBeVisible();
  expect(card.queryByTestId("durable-item-evidence-details")).toBeNull();
  expect(origin.readFile).toHaveBeenLastCalledWith(
    "/workspaces/parked",
    "startup-trace.md",
    undefined,
    65_536,
  );
  expect(active.readFile).not.toHaveBeenCalled();

  await act(async () => page.getByRole("button", { name: "Back", exact: true }).click());
  await expect.element(previous).toBeVisible();
  await expect.element(sheet).not.toBeInTheDocument();
  expect(card.queryByTestId("durable-item-evidence-details")).toBeNull();
  expect(origin.decide).not.toHaveBeenCalled();
});
