import React, { act } from "react";
import { PortalProvider } from "@gorhom/portal";
import { NavigationContext } from "expo-router/react-navigation";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { within } from "@testing-library/dom";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import type { WorkspaceDurableItem } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { ToastProvider } from "@/contexts/toast-context";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { i18n } from "@/i18n/i18next";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MobilePanelsProvider } from "@/mobile-panels/provider";
import { AgentConversationPanel } from "@/panels/agent-panel";
import {
  PaneFocusProvider,
  PaneProvider,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";
import { getHostRuntimeStore, type HostRuntimeSnapshot } from "@/runtime/host-runtime";
import { SheetPaneHostProvider, type SheetPaneHost } from "@/screens/workspace/sheet-pane";
import { SheetTabs } from "@/screens/workspace/sheet-tabs";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { TURN_LIVENESS_IDLE } from "@/timeline/turn-liveness";
import { AgentDurableItems, DurableItemCard } from "./card";

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

// The shared browser stub omits some icons loaded transitively by the conversation panel.
vi.mock("lucide-react-native", async (importOriginal) => {
  const stub = await importOriginal<typeof import("lucide-react-native")>();
  const extra = [
    "AlertCircle",
    "BookOpen",
    "Boxes",
    "Bug",
    "Cloud",
    "Compass",
    "CornerUpLeft",
    "Cpu",
    "Database",
    "Feather",
    "FlaskConical",
    "Gauge",
    "GripVertical",
    "Hammer",
    "Microscope",
    "Minimize2",
    "Package",
    "Palette",
    "PanelLeftClose",
    "Rocket",
    "Summary",
    "TestTube",
    "TextQuote",
  ];
  return { ...stub, ...Object.fromEntries(extra.map((name) => [name, stub.Info])) };
});

const pending = {
  workspaceId: "workspace",
  requestId: "request",
  sourceAgentId: "agent",
  sourceTurnId: "turn",
  kind: "authorization",
  title: "Workspace authorization",
  evidence: [],
  createdAt: "2026-01-01T00:00:00Z",
  status: "pending",
  revision: 0,
} satisfies WorkspaceDurableItem;

function decided(item: WorkspaceDurableItem): WorkspaceDurableItem {
  return {
    ...item,
    status: "decided",
    revision: item.revision + 1,
    decision: "approve",
    decidedAt: item.createdAt,
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const previousSessions = useSessionStore.getState().sessions;

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  useSessionStore.setState({ sessions: previousSessions });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function serve(items: WorkspaceDurableItem[]) {
  const list = vi.fn<DaemonClient["listWorkspaceDurableItems"]>(async () => ({
    requestId: "read",
    items: [...items],
    nextCursor: null,
    error: null,
  }));
  const decide = vi.fn<DaemonClient["decideWorkspaceDurableItem"]>();
  const readFile = vi.fn<DaemonClient["readFile"]>();
  const client = Object.assign(new DaemonClient({ url: "ws://unused.test", clientId: "host" }), {
    readFile,
    listWorkspaceDurableItems: list,
    decideWorkspaceDurableItem: decide,
  });
  const store = useSessionStore.getState();
  store.initializeSession("host", client, 1);
  store.updateSessionServerInfo("host", {
    serverId: "host",
    hostname: null,
    version: null,
    features: { workspaceDurableItemsV1: true },
  });
  const snapshot: {
    connectionStatus: HostRuntimeSnapshot["connectionStatus"];
    client: Pick<
      DaemonClient,
      "listWorkspaceDurableItems" | "decideWorkspaceDurableItem" | "readFile"
    >;
  } = {
    connectionStatus: "online",
    client,
  };
  vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockImplementation(
    () => snapshot as unknown as HostRuntimeSnapshot,
  );
  return { list, decide, snapshot, readFile };
}

function render(agentId = "agent", active = true, pendingOnly = false) {
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RetainedPanelActivity active={active}>
          <AgentDurableItems
            serverId="host"
            workspaceId="workspace"
            agentId={agentId}
            pendingOnly={pendingOnly}
          />
        </RetainedPanelActivity>
      </QueryClientProvider>,
    ),
  );
  return within(container);
}

function seedConversationAgents(mainAgentId?: string) {
  const store = useSessionStore.getState();
  const date = new Date(pending.createdAt);
  const shared: Omit<Agent, "id"> = {
    serverId: "host",
    workspaceId: "workspace",
    provider: "codex",
    status: "closed",
    cwd: "/workspace",
    turn: TURN_LIVENESS_IDLE,
    createdAt: date,
    updatedAt: date,
    lastActivityAt: date,
    lastUserMessageAt: date,
    archivedAt: date,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "Conversation",
    model: null,
    parentAgentId: null,
    labels: {},
  };
  store.setAgents(
    "host",
    new Map<string, Agent>(
      ["agent", "sibling-agent"].map((id) => [
        id,
        {
          ...shared,
          id,
          status: id === mainAgentId ? "idle" : shared.status,
          archivedAt: id === mainAgentId ? null : shared.archivedAt,
          labels:
            id === mainAgentId ? { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE } : shared.labels,
        },
      ]),
    ),
  );
  if (mainAgentId) {
    store.applyAgentTimelineResponseState("host", mainAgentId, {
      items: [],
      head: [],
      range: null,
      older: "none",
      newer: false,
      synchronized: true,
      acknowledgedClientMessageIds: [],
    });
  }
}

function conversationPane(agentId: string, host: PaneContextValue["host"]): PaneContextValue {
  const noop = () => {};
  return {
    serverId: "host",
    workspaceId: "workspace",
    host,
    tabId: agentId,
    target: { kind: "agent", agentId },
    closeCurrentTab: noop,
    openTab: noop,
    openPreferredTarget: noop,
    retargetCurrentTab: noop,
    setCurrentTabState: noop,
    openFileInWorkspace: noop,
    openImportSheet: noop,
  };
}

type Navigation = NonNullable<React.ContextType<typeof NavigationContext>>;
const focusedNavigation = {
  isFocused: () => true,
  addListener: () => () => {},
} satisfies Pick<Navigation, "isFocused" | "addListener">;
const navigation = focusedNavigation as unknown as Navigation;
async function closeTab() {}

function WithWorkspaceSheet({
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
          {children}
          <SheetTabs onCloseTab={closeTab} />
        </SheetPaneHostProvider>
      </DiffDocumentWorkspaceCacheProvider>
    </NavigationContext.Provider>
  );
  return (
    <GestureHandlerRootView>
      <SafeAreaProvider>{workspace}</SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function renderConversation(
  agentId: string,
  {
    active = true,
    focused = true,
    sheetHost,
    paneHost = "main",
  }: {
    active?: boolean;
    focused?: boolean;
    sheetHost?: SheetPaneHost;
    paneHost?: PaneContextValue["host"];
  } = {},
) {
  const value = conversationPane(agentId, paneHost);
  const conversation = (
    <RetainedPanelActivity active={active}>
      <PaneProvider value={value}>
        <PaneFocusProvider
          value={createPaneFocusContextValue({
            isWorkspaceFocused: active,
            isPaneFocused: focused,
          })}
        >
          <ToastProvider>
            <KeyboardActionDispatcherProvider>
              <AgentConversationPanel />
            </KeyboardActionDispatcherProvider>
          </ToastProvider>
        </PaneFocusProvider>
      </PaneProvider>
    </RetainedPanelActivity>
  );
  const content = sheetHost ? (
    <WithWorkspaceSheet host={sheetHost}>{conversation}</WithWorkspaceSheet>
  ) : (
    conversation
  );
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <PortalProvider>
          <MobilePanelsProvider>{content}</MobilePanelsProvider>
        </PortalProvider>
      </QueryClientProvider>,
    ),
  );
  return within(container);
}

it("shows only pending requests from this agent and workspace", async () => {
  const { list } = serve([
    pending,
    decided({ ...pending, requestId: "old", title: "Earlier authorization" }),
    {
      ...pending,
      requestId: "sibling",
      sourceAgentId: "sibling-agent",
      title: "Another agent's request",
    },
    { ...pending, workspaceId: "other", title: "Another workspace's request" },
  ]);
  seedConversationAgents("agent");
  const sheetHost: SheetPaneHost = {
    workspaceKey: "host:workspace",
    serverId: "host",
    workspaceId: "workspace",
    isWorkspaceFocused: true,
    buildContent: () => {
      throw new Error("No additional sheet is opened by this test");
    },
  };
  const view = renderConversation("agent", { paneHost: "sheet", sheetHost });
  await view.findByText("Workspace authorization");
  expect(view.queryByText("Earlier authorization")).toBeNull();
  expect(view.getAllByTestId("durable-item-card")).toHaveLength(1);
  expect(view.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
  expect(view.queryByText(/^Needs my action/)).toBeNull();
  expect(view.queryByText("Another workspace's request")).toBeNull();
  expect(view.queryByText("Another agent's request")).toBeNull();

  renderConversation("sibling-agent", { paneHost: "sheet", sheetHost });
  await expect.element(await view.findByText("Another agent's request")).toBeVisible();
  expect(view.queryByText("Workspace authorization")).toBeNull();
  expect(list.mock.calls.map(([scope]) => scope)).toEqual([
    { workspaceId: "workspace", limit: 100, cursor: undefined },
  ]);
});

it("keeps resolved requests visible in an ordinary conversation", async () => {
  serve([pending, decided({ ...pending, requestId: "old", title: "Earlier authorization" })]);
  seedConversationAgents();
  const view = renderConversation("agent");
  await view.findByText("Earlier authorization");
  expect(view.getAllByTestId("durable-item-card")).toHaveLength(2);
  expect(view.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
});

it("refreshes the production conversation on focus and on activation after hiding", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { list } = serve([pending]);
  seedConversationAgents();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  act(() => window.dispatchEvent(new FocusEvent("focus")));
  const view = renderConversation("agent", { focused: false });
  await view.findByText(pending.title);

  renderConversation("agent");
  expect(list).toHaveBeenCalledTimes(2);
  renderConversation("agent", { active: false });
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(list).toHaveBeenCalledTimes(2);

  renderConversation("agent");
  await expect.poll(() => list.mock.calls.length).toBe(3);
  vi.mocked(document.hasFocus).mockReturnValue(false);
  act(() => window.dispatchEvent(new FocusEvent("blur")));
  vi.mocked(document.hasFocus).mockReturnValue(true);
  act(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect.poll(() => list.mock.calls.length).toBe(4);
});

const review = {
  ...pending,
  requestId: "stale-review",
  kind: "acceptance",
  evidence: [{ type: "file", path: "trace.md", fingerprint: "saved" }],
} satisfies WorkspaceDurableItem;

it("blocks a stale evidence revision in both the conversation and the sidebar detail", async () => {
  const { decide } = serve([review]);
  decide.mockResolvedValue({
    requestId: "reply",
    workspaceId: review.workspaceId,
    durableItemRequestId: review.requestId,
    item: null,
    error: "Stale",
    errorCode: "DURABLE_ITEM_STALE_EVIDENCE",
  });
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentDurableItems serverId="host" workspaceId="workspace" agentId="agent" />
        <DurableItemCard serverId="host" item={review} />
      </QueryClientProvider>,
    ),
  );
  const view = within(container);
  const conversation = within(await view.findByTestId("agent-durable-items"));
  const accept = conversation.getByRole("button", { name: "Accept" });
  await expect.element(accept).toBeEnabled();
  act(() => accept.click());
  await expect.poll(() => view.getAllByText(/The evidence has changed/).length).toBe(2);
  const actions = view.getAllByRole("button", { name: "Accept" });
  expect(actions).toHaveLength(2);
  for (const action of actions) await expect.element(action).toBeDisabled();
  expect(decide).toHaveBeenCalledTimes(1);
  expect(view.queryByText("Approved")).toBeNull();
});

it("collapses the request list when the last pending request is resolved remotely", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const items: WorkspaceDurableItem[] = [pending];
  const { list, decide } = serve(items);
  const view = render("agent", true, true);
  await expect.element(await view.findByRole("button", { name: "Approve" })).toBeEnabled();

  items[0] = decided(pending);
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  await expect.poll(() => view.queryByTestId("agent-durable-items")).toBeNull();
  expect(view.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(decide).not.toHaveBeenCalled();

  render("agent", false, true);
  const callsBeforeHiding = list.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(list).toHaveBeenCalledTimes(callsBeforeHiding);
});

it("collapses the request list after a confirmed decision before refreshing the list", async () => {
  const { list, decide } = serve([pending]);
  const view = render("agent", true, true);
  const approve = await view.findByRole("button", { name: "Approve" });
  await expect.element(approve).toBeEnabled();
  const result = decided(pending);
  let finishRefresh!: (response: Awaited<ReturnType<typeof list>>) => void;
  list.mockImplementationOnce(() => new Promise((resolve) => (finishRefresh = resolve)));
  decide.mockResolvedValueOnce({
    requestId: "write",
    workspaceId: pending.workspaceId,
    durableItemRequestId: pending.requestId,
    item: result,
    error: null,
  });

  act(() => approve.click());
  await expect.poll(() => view.queryByTestId("agent-durable-items")).toBeNull();
  expect(decide).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0 }));
  expect(list).toHaveBeenCalledTimes(2);
  await act(async () =>
    finishRefresh({ requestId: "read-again", items: [result], nextCursor: null, error: null }),
  );
});

it("blocks a cached action until a returning host confirms its latest state", async () => {
  const { list, decide, snapshot } = serve([pending]);
  const renderPending = () => render("agent", true, true);
  const view = renderPending();
  await expect.element(await view.findByRole("button", { name: "Approve" })).toBeEnabled();

  snapshot.connectionStatus = "offline";
  renderPending();
  await expect.element(view.getByRole("button", { name: "Approve" })).toBeDisabled();

  let finishRefresh!: (response: Awaited<ReturnType<typeof list>>) => void;
  list.mockImplementationOnce(() => new Promise((resolve) => (finishRefresh = resolve)));
  snapshot.connectionStatus = "online";
  renderPending();
  await expect.element(view.getByText("Checking this request…")).toBeVisible();
  await expect.element(view.getByRole("button", { name: "Approve" })).toBeDisabled();
  expect(decide).not.toHaveBeenCalled();
  await act(async () =>
    finishRefresh({ requestId: "new", items: [decided(pending)], nextCursor: null, error: null }),
  );
  await expect.poll(() => view.queryByTestId("agent-durable-items")).toBeNull();
  expect(view.queryByRole("button", { name: "Approve" })).toBeNull();
});

it("opens compact conversation evidence through the workspace's shared sheet", async () => {
  await page.viewport(390, 720);
  const item = { ...review, requestId: "compact-review", title: "Compact review" };
  const { readFile, decide } = serve([item]);
  seedConversationAgents();
  const { sessions } = useSessionStore.getState();
  const workspace = {
    id: item.workspaceId,
    workspaceDirectory: "/workspace",
  } as WorkspaceDescriptor;
  useSessionStore.setState({
    sessions: {
      ...sessions,
      host: { ...sessions.host!, workspaces: new Map([[item.workspaceId, workspace]]) },
    },
  });
  const bytes = new TextEncoder().encode("Compact evidence contents");
  readFile.mockResolvedValue({
    bytes,
    mime: "text/plain",
    size: bytes.length,
    path: "trace.md",
    kind: "text",
    modifiedAt: pending.createdAt,
  });
  const view = renderConversation("agent", {
    sheetHost: {
      workspaceKey: "host:workspace",
      serverId: "host",
      workspaceId: item.workspaceId,
      isWorkspaceFocused: true,
      buildContent: () => {
        throw new Error("Expected a workspace sheet page");
      },
    },
  });
  const card = within(await view.findByTestId("durable-item-card"));
  act(() => card.getByRole("button", { name: "trace.md" }).click());
  const sheet = page.getByRole("dialog", { name: "trace.md" });
  await expect.element(sheet.getByText("Compact evidence contents")).toBeVisible();
  expect(card.queryByTestId("durable-item-evidence-details")).toBeNull();
  expect(readFile).toHaveBeenCalledWith("/workspace", "trace.md", undefined, 65_536);
  expect(decide).not.toHaveBeenCalled();
});
