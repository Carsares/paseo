import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  SIDE_CHAT_LABEL,
  SIDE_OF_AGENT_ID_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { PendingSubagentInbox } from "@getpaseo/protocol/messages";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, within } from "@testing-library/dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  CHAT_OUTLINE_GUTTER_INSET,
  CHAT_OUTLINE_MIN_PANEL_WIDTH,
} from "@/agent-stream/chat-outline/geometry";
import {
  TopicStreamModeControl,
  TopicStreamModeHeaderProvider,
} from "@/agent-stream/topic-card/topic-stream-mode-control";
import { CHAT_COLUMN_RAIL_DATASET, ChatColumnRailSurface } from "@/chat-rail";
import { CommandCenterProvider } from "@/command-center/provider";
import { ToastProvider } from "@/contexts/toast-context";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_APP_SETTINGS } from "@/hooks/use-settings/storage";
import { i18n } from "@/i18n/i18next";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import { MobilePanelsProvider } from "@/mobile-panels/provider";
import {
  createPaneFocusContextValue,
  PaneFocusProvider,
  PaneProvider,
  type PaneContextValue,
} from "@/panels/pane-context";
import { getHostRuntimeStore, type HostRuntimeSnapshot } from "@/runtime/host-runtime";
import { SheetPaneHostProvider, type SheetPaneHost } from "@/screens/workspace/sheet-pane/host";
import {
  buildDecisionRecoveryScope,
  useDecisionRecoveryStore,
  useDraftStore,
} from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { resolveReplyComposerDraftKey } from "@/agent-stream/topic-card/submit-topic-reply";
import {
  buildTopicAgentKey,
  buildTopicReplyDraftKey,
  useTopicStreamViewStore,
} from "@/stores/topic-stream-view-store";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
import {
  createTeamMessageJumpStore,
  TeamMessageJumpProvider,
} from "@/subagents/team-directory/message-jump-store";
import { workspaceTopicReadQueryKey } from "@/topic-read/queries";
import type { StreamItem } from "@/types/stream";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { AgentConversationPanel } from "./agent-panel";
import { PendingSubagentInboxBar } from "./agent-panel-inbox";

vi.mock("@/stores/navigation-active-workspace-store", { spy: true });

vi.mock("@/styles/theme", async (importOriginal) => {
  const theme = await importOriginal<typeof import("@/styles/theme")>();
  return {
    ...theme,
    lightTheme: {
      ...theme.lightTheme,
      // The browser test double resolves theme styles once. A variable lets the test switch widths.
      contentMaxWidth: `var(--test-content-max-width, ${theme.DEFAULT_CONTENT_MAX_WIDTH}px)`,
    },
  };
});

let compactTestLayout: boolean | undefined;
vi.mock("@/constants/layout", async (importOriginal) => {
  const layout = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...layout,
    useIsCompactFormFactor: () => {
      const actual = layout.useIsCompactFormFactor();
      return compactTestLayout ?? actual;
    },
  };
});

const serverId = "inbox-host";
const agentId = "inbox-agent";
const inbox: PendingSubagentInbox = {
  count: 2,
  items: [
    { agentId: "reviewer", title: "Reviewer", event: "finished" },
    { agentId: "subagent-123456", event: "finished" },
  ],
};
const noop = () => {};
const pane: PaneContextValue = {
  serverId,
  workspaceId: "workspace",
  tabId: "agent-tab",
  host: "main",
  target: { kind: "agent", agentId },
  openTab: noop,
  openPreferredTarget: noop,
  closeCurrentTab: noop,
  retargetCurrentTab: noop,
  setCurrentTabState: noop,
  openFileInWorkspace: noop,
  openImportSheet: noop,
};
const sheetPane: PaneContextValue = { ...pane, host: "sheet" };
const insets = { top: 0, right: 0, bottom: 0, left: 0 };
const paneFocus = createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true });
const sheetHost: SheetPaneHost = {
  serverId,
  workspaceId: pane.workspaceId,
  workspaceKey: `${serverId}:${pane.workspaceId}`,
  isWorkspaceFocused: true,
  buildContent: () => {
    throw new Error("The chat click does not open a sheet");
  },
};
const store = useSessionStore.getState();
let container: HTMLDivElement;
let root: Root;
let view: ReturnType<typeof within>;

beforeEach(async () => {
  compactTestLayout = undefined;
  await page.viewport(1000, 760);
  await i18n.changeLanguage("en");
  container = document.body.appendChild(document.createElement("div"));
  container.style.width = "1000px";
  root = createRoot(container);
  view = within(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  store.clearSession(serverId);
  useTopicStreamViewStore
    .getState()
    .setActiveReplyTopic(buildTopicAgentKey(serverId, agentId), null);
  useTopicStreamViewStore.getState().closeTodoEditor();
  container.remove();
});

function initializeSession(flushAgentInbox: DaemonClient["flushAgentInbox"] = vi.fn()) {
  store.initializeSession(serverId, { flushAgentInbox } as unknown as DaemonClient);
}

function enableInbox({ outline = false } = {}) {
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: null,
    features: { subagentInbox: true, agentTimelinePromptIndex: outline },
  });
}

function renderInbox(hidden = false) {
  act(() =>
    root.render(<PendingSubagentInboxBar serverId={serverId} agentId={agentId} hidden={hidden} />),
  );
}

function publishAgent(
  isMain: boolean,
  pendingSubagentInbox?: PendingSubagentInbox,
  requiresAttention = false,
  workspaceId?: string,
  status: "idle" | "running" = "idle",
) {
  const agent = normalizeAgentSnapshot(
    {
      id: agentId,
      provider: "codex",
      cwd: "/repo",
      workspaceId,
      model: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:01:00.000Z",
      lastUserMessageAt: null,
      status,
      requiresAttention,
      attentionReason: requiresAttention ? "finished" : null,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: isMain ? { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE } : {},
      pendingSubagentInbox,
    },
    serverId,
  );
  store.setAgents(serverId, new Map([[agentId, agent]]));
}

function ConversationShell({ children }: { children: ReactNode }) {
  return (
    <SafeAreaInsetsContext.Provider value={insets}>
      <ToastProvider>
        <CommandCenterProvider>
          <KeyboardActionDispatcherProvider>
            <MobilePanelsProvider>{children}</MobilePanelsProvider>
          </KeyboardActionDispatcherProvider>
        </CommandCenterProvider>
      </ToastProvider>
    </SafeAreaInsetsContext.Provider>
  );
}

function ConversationPane({
  children,
  paneHost = pane.host,
}: {
  children: ReactNode;
  paneHost?: PaneContextValue["host"];
}) {
  return (
    <PaneProvider value={paneHost === "sheet" ? sheetPane : pane}>
      <PaneFocusProvider value={paneFocus}>
        <DiffDocumentWorkspaceCacheProvider>
          <SheetPaneHostProvider value={sheetHost}>
            <KeyboardProvider>
              <KeyboardShiftProvider>{children}</KeyboardShiftProvider>
            </KeyboardProvider>
          </SheetPaneHostProvider>
        </DiffDocumentWorkspaceCacheProvider>
      </PaneFocusProvider>
    </PaneProvider>
  );
}

async function mountTopicConversation(
  client: DaemonClient,
  hasTopics: boolean,
  width: number,
  queueWhenRunning = false,
  additionalTopicItems: StreamItem[] = [],
  modeInHeader = false,
  options?: {
    paneHost?: PaneContextValue["host"];
    sideChatSourceId?: string;
    rewindRecovery?: "ordinary" | "main";
    headerWorkspaceId?: string;
    paneFallback?: { agentId: string; tabId: string };
    chatOutline?: boolean;
  },
) {
  compactTestLayout = width < 600;
  await page.viewport(width, 760);
  container.style.width = `${width}px`;
  container.style.height = "640px";
  const snapshot: HostRuntimeSnapshot = {
    serverId,
    client,
    connectionStatus: "online",
    activeConnectionId: null,
    activeConnection: null,
    lastError: null,
    lastOnlineAt: null,
    agentDirectoryStatus: "ready",
    agentDirectoryError: null,
    hasEverLoadedAgentDirectory: true,
    probeByConnectionId: new Map(),
    clientGeneration: 0,
    connectionEpoch: 0,
  };
  const runtime = getHostRuntimeStore();
  const getSnapshot = runtime.getSnapshot.bind(runtime);
  vi.spyOn(runtime, "getSnapshot").mockImplementation((id) =>
    id === serverId ? snapshot : getSnapshot(id),
  );
  store.initializeSession(serverId, client);
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: null,
    features: {
      workspaceTopicReadState: true,
      workspaceTopicThreads: true,
      rewindPendingFiles: Boolean(options?.rewindRecovery),
      agentTimelinePromptIndex: Boolean(options?.chatOutline),
    },
  });
  publishAgent(
    options?.rewindRecovery !== "ordinary",
    undefined,
    false,
    pane.workspaceId,
    queueWhenRunning ? "running" : "idle",
  );
  if (options?.sideChatSourceId) {
    const main = useSessionStore.getState().sessions[serverId]!.agents.get(agentId)!;
    store.setAgents(
      serverId,
      new Map([
        [options.sideChatSourceId, { ...main, id: options.sideChatSourceId }],
        [
          agentId,
          {
            ...main,
            labels: {
              [SIDE_CHAT_LABEL]: "true",
              [SIDE_OF_AGENT_ID_LABEL]: options.sideChatSourceId,
            },
          },
        ],
      ]),
    );
  }
  useTopicStreamViewStore
    .getState()
    .setViewMode(
      buildTopicAgentKey(serverId, agentId),
      options?.sideChatSourceId ? "timeline" : "topics",
    );
  store.applyAgentTimelineResponseState(serverId, agentId, {
    items: [
      ...(hasTopics
        ? ["a", "b"].map((id) => ({
            kind: "user_message" as const,
            id,
            messageId: id,
            text: `Topic ${id}`,
            timestamp: new Date("2026-04-20T00:00:00.000Z"),
          }))
        : []),
      ...additionalTopicItems,
    ],
    head: [],
    range: null,
    older: "none",
    newer: false,
    synchronized: true,
    acknowledgedClientMessageIds: [],
  });
  const settings = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (additionalTopicItems.length > 0) {
    settings.setQueryData(workspaceTopicReadQueryKey(serverId, pane.workspaceId, agentId), {
      workspaceId: pane.workspaceId,
      mainAgentId: agentId,
      watermarkEpoch: "browser-epoch",
      watermarkSeq: 0,
      watermarkTimestampMs: 0,
      topics: [],
      revision: 1,
    });
  }
  settings.setQueryData(APP_SETTINGS_QUERY_KEY, {
    ...DEFAULT_APP_SETTINGS,
    ...(queueWhenRunning ? { sendBehavior: "queue" } : {}),
    ...(options?.chatOutline ? { chatOutlineEnabled: true } : {}),
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={settings}>
        <ConversationShell>
          <TeamMessageJumpProvider store={createTeamMessageJumpStore()}>
            <ConversationPane paneHost={options?.paneHost}>
              <TopicStreamModeHeaderProvider
                serverId={serverId}
                workspaceId={options?.headerWorkspaceId ?? pane.workspaceId}
                agentId={modeInHeader || options?.headerWorkspaceId ? agentId : null}
                paneFallback={options?.paneFallback}
              >
                {modeInHeader ? (
                  <TopicStreamModeControl
                    serverId={serverId}
                    agentId={agentId}
                    workspaceId={pane.workspaceId}
                    compact={width < 600}
                  />
                ) : null}
                <AgentConversationPanel />
              </TopicStreamModeHeaderProvider>
            </ConversationPane>
          </TeamMessageJumpProvider>
        </ConversationShell>
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => {
    expect(
      view.getByTestId(
        options?.sideChatSourceId || options?.rewindRecovery === "ordinary"
          ? "assistant-message"
          : "topic-stream-list",
      ),
    ).toBeTruthy();
  });
}

it.each(["main", "ordinary"] as const)(
  "loads pending file recovery only for ordinary conversations (%s)",
  async (kind) => {
    const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
    const recovery = vi.spyOn(client, "getAgentRewindFileRecovery").mockResolvedValue({
      pendingFiles: [],
      unconfirmedFileRewinds: [],
    });
    await mountTopicConversation(
      client,
      true,
      1000,
      false,
      [
        {
          kind: "assistant_message",
          id: "rewind-answer",
          messageId: "rewind-answer",
          text: "Conversation ready",
          timestamp: new Date("2026-04-20T00:03:00.000Z"),
        },
      ],
      false,
      { rewindRecovery: kind },
    );
    if (kind === "ordinary") {
      await vi.waitFor(() => expect(recovery).toHaveBeenCalledExactlyOnceWith(agentId));
    } else {
      expect(recovery).not.toHaveBeenCalled();
    }
  },
);

it("shows the pane toolbar when the header belongs to another workspace", async () => {
  const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
  await mountTopicConversation(client, true, 1000, false, [], false, {
    headerWorkspaceId: "another-workspace",
  });
  expect(view.getAllByTestId("topic-stream-mode-switch")).toHaveLength(1);
  expect(view.getByTestId("topic-stream-top-bar")).toBeTruthy();
});

it.each([
  { fallbackTabId: pane.tabId, showsModeSwitch: true },
  { fallbackTabId: "other-main-tab", showsModeSwitch: false },
])(
  "shows the fallback on the selected copy of a split Main tab ($fallbackTabId)",
  async ({ fallbackTabId, showsModeSwitch }) => {
    const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
    await mountTopicConversation(client, true, 1000, false, [], false, {
      paneFallback: { agentId, tabId: fallbackTabId },
    });
    expect(Boolean(view.queryByTestId("topic-stream-top-bar"))).toBe(showsModeSwitch);
  },
);

it.each([
  { width: 1000, language: "en", topicsName: "Topic stream", timelineName: "Full timeline" },
  { width: 390, language: "en", topicsName: "Topic stream", timelineName: "Full timeline" },
  { width: 320, language: "zh-CN", topicsName: "任务话题流", timelineName: "完整时间线" },
])(
  "switches the active conversation from the header at $width px ($language)",
  async ({ width, language, topicsName, timelineName }) => {
    await i18n.changeLanguage(language);
    const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
    vi.spyOn(client, "markWorkspaceTopicRead").mockImplementation(() => new Promise(() => {}));
    const markAllRead = vi
      .spyOn(client, "markAllWorkspaceTopicsRead")
      .mockResolvedValue({ requestId: "mark-all", snapshots: [], error: null });
    const agentKey = buildTopicAgentKey(serverId, agentId);
    const switcher = page.getByTestId("topic-stream-mode-switch");
    const topicsOption = page.getByTestId("topic-stream-mode-topics");
    const timelineOption = page.getByTestId("topic-stream-mode-timeline");
    const isCompact = width < 600;
    const actionTrigger = isCompact ? switcher : page.getByTestId("topic-stream-actions");
    await mountTopicConversation(
      client,
      true,
      width,
      false,
      [
        {
          kind: "assistant_message",
          id: "unread-answer",
          messageId: "unread-answer",
          text: "Unread answer",
          timestamp: new Date("2026-04-20T00:01:00.000Z"),
          timelineCursor: { epoch: "browser-epoch", seq: 2 },
        },
      ],
      true,
    );

    expect(view.queryByTestId("topic-stream-top-bar")).toBeNull();
    expect(view.getAllByTestId("topic-stream-mode-switch")).toHaveLength(1);
    if (isCompact) {
      await expect.element(switcher).toHaveAccessibleName(topicsName);
      const { width: buttonWidth, height: buttonHeight } = switcher
        .element()
        .getBoundingClientRect();
      expect([buttonWidth, buttonHeight]).toEqual([44, 44]);
      await userEvent.click(switcher);
      await expect.element(topicsOption).toHaveAttribute("aria-checked", "true");
      await expect.element(timelineOption).toHaveAttribute("aria-checked", "false");
    }
    await userEvent.click(timelineOption);
    await expect.element(page.getByTestId("topic-stream-list")).not.toBeInTheDocument();
    expect(useTopicStreamViewStore.getState().viewModeByAgentKey[agentKey]).toBe("timeline");

    if (isCompact) {
      await expect.element(switcher).toHaveAccessibleName(timelineName);
    }
    await userEvent.click(actionTrigger);
    if (isCompact) {
      await expect.element(topicsOption).toHaveAttribute("aria-checked", "false");
      await expect.element(timelineOption).toHaveAttribute("aria-checked", "true");
    }
    expect(page.getByTestId("topic-stream-unread-only").query()).toBeNull();
    await userEvent.click(page.getByTestId("topic-stream-mark-all-read"));
    expect(markAllRead).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceId: pane.workspaceId, mainAgentId: agentId, maxSeq: 2 }),
    );
    await userEvent.click(actionTrigger);
    await userEvent.click(page.getByTestId("topic-stream-add-todo"));
    expect(useTopicStreamViewStore.getState().todoEditorRequest).toEqual({
      serverId,
      workspaceId: pane.workspaceId,
    });
    if (isCompact) await userEvent.click(switcher);
    await userEvent.click(topicsOption);
    await expect.element(page.getByTestId("topic-stream-list")).toBeInTheDocument();
    expect(useTopicStreamViewStore.getState().viewModeByAgentKey[agentKey]).toBe("topics");
  },
);

it("preserves a wide draft when the viewport marks its topic read and the filter hides it", async () => {
  const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
  const response =
    Promise.withResolvers<Awaited<ReturnType<DaemonClient["markWorkspaceTopicRead"]>>>();
  const markRead = vi.spyOn(client, "markWorkspaceTopicRead").mockReturnValue(response.promise);
  const topicView = useTopicStreamViewStore.getState();
  const agentKey = buildTopicAgentKey(serverId, agentId);
  const timestamp = new Date("2026-04-20T00:01:00.000Z");
  topicView.setUnreadOnly(agentKey, true);
  try {
    await mountTopicConversation(client, true, 1000, false, [
      {
        kind: "assistant_message",
        id: "visible-answer",
        messageId: "visible-answer",
        text: "Answer visible in B",
        timestamp,
        timelineCursor: { epoch: "browser-epoch", seq: 2 },
      },
    ]);
    await userEvent.click(page.getByTestId("topic-inline-reply-trigger-msg:b"));
    const input = page.getByTestId("topic-inline-reply-input-msg:b");
    await input.fill("Draft while reading");
    await vi.waitFor(
      () =>
        expect(markRead).toHaveBeenCalledWith(
          expect.objectContaining({ topicKey: "msg:b", epoch: "browser-epoch", seq: 2 }),
        ),
      5000,
    );
    await act(async () => {
      response.resolve({
        requestId: "auto-read",
        snapshot: {
          workspaceId: pane.workspaceId,
          mainAgentId: agentId,
          watermarkEpoch: "browser-epoch",
          watermarkSeq: 2,
          watermarkTimestampMs: timestamp.getTime(),
          topics: [],
          revision: 2,
        },
        error: null,
      });
    });
    await expect.element(input).not.toBeInTheDocument();
    expect(view.getByTestId("topic-stream-top-bar")).toBeTruthy();
    await userEvent.click(page.getByTestId("topic-stream-actions"));
    await userEvent.click(page.getByTestId("topic-stream-unread-only"));
    await expect.element(input).toHaveValue("Draft while reading");
  } finally {
    topicView.setUnreadOnly(agentKey, false);
  }
});

it.each([
  [390, false],
  [1000, true],
] as const)(
  "handles the main permission request in the topic stream at %i px (topics: %s)",
  async (width, hasTopics) => {
    const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
    const respond = vi
      .spyOn(client, "respondToPermissionAndWait")
      .mockResolvedValue({ agentId, requestId: "ask-1", resolution: { behavior: "allow" } });
    await mountTopicConversation(client, hasTopics, width);
    const request = {
      id: "ask-1",
      name: "Main request",
      kind: "tool" as const,
      provider: "codex" as const,
    };
    await act(async () => {
      store.setPendingPermissions(
        serverId,
        new Map([
          ["main", { key: "main", agentId, request }],
          [
            "other",
            {
              key: "other",
              agentId: "other-agent",
              request: { ...request, name: "Other request" },
            },
          ],
        ]),
      );
    });
    expect(view.queryByText("Other request")).toBeNull();
    await userEvent.click(page.getByTestId("permission-request-accept"));
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      agentId,
      "ask-1",
      expect.objectContaining({ behavior: "allow" }),
      15000,
    );
  },
);

it.each(["accepted", "rejected"] as const)(
  "keeps compact drafts and attachments isolated when A is %s after switching to B",
  async (result) => {
    const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
    const response =
      Promise.withResolvers<Awaited<ReturnType<DaemonClient["replyWorkspaceTopic"]>>>();
    const reply = vi.spyOn(client, "replyWorkspaceTopic").mockReturnValue(response.promise);
    const drafts = useDraftStore.getState();
    const draftKey = (topicKey: string) =>
      buildTopicReplyDraftKey({
        serverId,
        workspaceId: pane.workspaceId,
        agentId,
        topicKey,
      });
    for (const id of ["a", "b"]) {
      drafts.saveDraftInput({
        draftKey: draftKey(`msg:${id}`),
        draft: {
          text: `Draft ${id}`,
          attachments: [
            {
              kind: "file",
              attachment: {
                type: "uploaded_file",
                id,
                path: `/tmp/${id}.txt`,
                fileName: `${id}.txt`,
                mimeType: "text/plain",
                size: 1,
              },
            },
          ],
        },
      });
    }
    await mountTopicConversation(client, true, 390, false, [quoteAnswer]);
    await userEvent.click(page.getByTestId("topic-inline-reply-compact-msg:a"));
    await vi.waitFor(() =>
      expect(view.getByTestId("composer-file-attachment-pill").textContent).toContain("a.txt"),
    );
    await userEvent.click(page.getByRole("button", { name: "Send message", exact: true }));
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          topicKey: "msg:a",
          text: "Draft a",
          attachments: [expect.objectContaining({ id: "a" })],
        }),
      ),
    );
    if (result === "accepted") {
      const agentKey = buildTopicAgentKey(serverId, agentId);
      act(() => {
        useTopicStreamViewStore.getState().setViewMode(agentKey, "timeline");
      });
      await quoteTimelinePassage();
      expect(drafts.getDraftInput(draftKey("msg:a"))?.attachments.map(({ kind }) => kind)).toEqual([
        "file",
      ]);
      await expect
        .element(page.getByText("Wait for the current reply to finish before quoting."))
        .toBeVisible();
      act(() => {
        useTopicStreamViewStore.getState().setViewMode(agentKey, "topics");
      });
    }
    await userEvent.click(page.getByTestId("topic-inline-reply-compact-msg:b"));
    await act(async () => {
      response.resolve({
        requestId: "request",
        workspaceId: pane.workspaceId,
        topicKey: "msg:a",
        routedTo: "main",
        targetAgentId: agentId,
        entry: null,
        error: result === "rejected" ? "declined" : null,
      });
    });
    const b = drafts.getDraftInput(draftKey("msg:b"));
    expect(b?.text).toBe("Draft b");
    expect(b?.attachments).toHaveLength(1);
    expect(view.getByTestId("composer-file-attachment-pill").textContent).toContain("b.txt");
    await userEvent.click(page.getByTestId("topic-inline-reply-compact-msg:a"));
    const a = drafts.getDraftInput(draftKey("msg:a"));
    expect(a?.text ?? "").toBe(result === "accepted" ? "" : "Draft a");
    if (result === "accepted") {
      expect(view.queryByTestId("composer-file-attachment-pill")).toBeNull();
    } else {
      expect(view.getByTestId("composer-file-attachment-pill").textContent).toContain("a.txt");
    }
    for (const id of ["a", "b"])
      drafts.clearDraftInput({ draftKey: draftKey(`msg:${id}`), lifecycle: "abandoned" });
    useTopicStreamViewStore
      .getState()
      .setActiveReplyTopic(buildTopicAgentKey(serverId, agentId), null);
  },
);

const quoteAnswer = {
  kind: "assistant_message" as const,
  id: "quote-answer",
  messageId: "quote-answer",
  text: "Quote this passage and leave the rest.",
  timestamp: new Date("2026-04-20T00:01:00.000Z"),
  timelineCursor: { epoch: "browser-epoch", seq: 2 },
};

async function openSelectionMenu() {
  const row = page.getByText(quoteAnswer.text, { exact: true });
  await expect.element(row).toBeVisible();
  const element = row.element();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode()!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, "Quote this passage".length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => fireEvent.contextMenu(element, { clientX: 50, clientY: 70 }));
}

async function quoteTimelinePassage() {
  await openSelectionMenu();
  const quote = page.getByTestId("assistant-selection-context-menu-quote");
  await expect.element(quote).toBeVisible();
  act(() => fireEvent.click(quote.element()));
}

it.each(["ordinary", "reply", "decision"] as const)(
  "quotes a Timeline selection into the visible %s composer",
  async (kind) => {
    const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
    const agentKey = buildTopicAgentKey(serverId, agentId);
    const target =
      kind === "ordinary"
        ? null
        : {
            topicKey: "msg:a",
            rootMessageId: "a",
            promptPreview: "Topic A",
            routeMode: "main" as const,
            ...(kind === "decision"
              ? {
                  decisionContext: {
                    kind: "task_blocking_question" as const,
                    question: "Proceed?",
                  },
                }
              : {}),
          };
    const draftKey = resolveReplyComposerDraftKey({
      serverId,
      workspaceId: pane.workspaceId,
      agentId,
      target,
    });
    const ordinaryKey = buildDraftStoreKey({ serverId, agentId });
    const drafts = useDraftStore.getState();
    drafts.saveDraftInput({
      draftKey: ordinaryKey,
      draft: { text: "Ordinary draft", attachments: [] },
    });
    try {
      await mountTopicConversation(client, true, 390, false, [quoteAnswer]);
      if (kind === "reply") {
        await userEvent.click(page.getByTestId("topic-inline-reply-compact-msg:a"));
      } else if (target) {
        act(() => {
          useTopicStreamViewStore.getState().setActiveReplyTopic(agentKey, target);
        });
      }
      // Mode selection is exercised separately; this test starts from the resulting Timeline.
      act(() => {
        useTopicStreamViewStore.getState().setViewMode(agentKey, "timeline");
      });
      await quoteTimelinePassage();
      await expect.element(page.getByTestId("composer-quote-card")).toBeVisible();
      expect(drafts.getDraftInput(draftKey)?.attachments).toEqual([
        expect.objectContaining({ kind: "quote", text: "Quote this passage" }),
      ]);
      if (kind !== "ordinary") {
        expect(drafts.getDraftInput(ordinaryKey)).toEqual({
          text: "Ordinary draft",
          attachments: [],
        });
      }
    } finally {
      window.getSelection()?.removeAllRanges();
      for (const key of new Set([draftKey, ordinaryKey])) {
        drafts.clearDraftInput({ draftKey: key, lifecycle: "abandoned" });
      }
    }
  },
);

it("keeps the side chat quote on the Main composer reached through the asTab fallback", async () => {
  const sourceAgentId = "main-source";
  const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
  const navigate = vi.mocked(navigateToWorkspace).mockReturnValue("/workspace");
  const target = {
    topicKey: "msg:source",
    routeMode: "main" as const,
    promptPreview: "Source topic",
  };
  const sourceKey = buildTopicAgentKey(serverId, sourceAgentId);
  const draftKey = resolveReplyComposerDraftKey({
    serverId,
    workspaceId: pane.workspaceId,
    agentId: sourceAgentId,
    target,
  });
  try {
    await mountTopicConversation(client, true, 390, false, [quoteAnswer], false, {
      sideChatSourceId: sourceAgentId,
    });
    useTopicStreamViewStore.getState().setActiveReplyTopic(sourceKey, target);
    await quoteTimelinePassage();
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledExactlyOnceWith({
        serverId,
        workspaceId: pane.workspaceId,
        target: { kind: "agent", agentId: sourceAgentId },
        asTab: true,
      }),
    );
    expect(useDraftStore.getState().getDraftInput(draftKey)?.attachments).toEqual([
      expect.objectContaining({ kind: "quote", text: "Quote this passage" }),
    ]);
    expect(
      useDraftStore.getState().getDraftInput(buildDraftStoreKey({ serverId, agentId })),
    ).toBeUndefined();
  } finally {
    navigate.mockRestore();
    window.getSelection()?.removeAllRanges();
    useTopicStreamViewStore.getState().setActiveReplyTopic(sourceKey, null);
    useDraftStore.getState().clearDraftInput({ draftKey, lifecycle: "abandoned" });
  }
});

it("does not offer Quote in a read-only sheet without a composer", async () => {
  const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
  try {
    await mountTopicConversation(client, true, 390, false, [quoteAnswer], false, {
      paneHost: "sheet",
    });
    act(() => {
      useTopicStreamViewStore
        .getState()
        .setViewMode(buildTopicAgentKey(serverId, agentId), "timeline");
    });
    await openSelectionMenu();
    expect(view.queryByRole("textbox")).toBeNull();
    await expect
      .element(page.getByTestId("assistant-selection-context-menu-quote"))
      .not.toBeInTheDocument();
    await expect.element(page.getByTestId("assistant-selection-quote")).not.toBeInTheDocument();
  } finally {
    window.getSelection()?.removeAllRanges();
  }
});

it("moves a manually rejected queued decision to an editable draft without replacing a newer one", async () => {
  const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
  const newGeneration = "151eb610-81ef-4fb7-bacf-335f205fb173";
  const decide = vi.spyOn(client, "decideWorkspaceTopic").mockResolvedValue({
    requestId: "stale",
    workspaceId: pane.workspaceId,
    topicKey: "msg:a",
    accepted: false,
    durableItem: null,
    task: {
      taskId: "task-a",
      title: "Topic A",
      status: "awaiting_decision",
      tier: "T1",
      participants: [],
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:02:00.000Z",
      blockingQuestion: "Should we change the rollout?",
      blockingQuestionGeneration: newGeneration,
    },
    routedTo: "none",
    targetAgentId: null,
    entry: null,
    error: "The blocking question changed.",
    errorCode: "stale_blocking_question",
  });
  const target = {
    topicKey: "msg:a",
    taskId: "task-a",
    rootMessageId: "a",
    routeMode: "main" as const,
    promptPreview: "Topic A",
    decisionContext: {
      kind: "task_blocking_question" as const,
      question: "Proceed?",
      blockingQuestionGeneration: "old",
    },
  };
  const draftKey = resolveReplyComposerDraftKey({
    serverId,
    workspaceId: pane.workspaceId,
    agentId,
    target,
  });
  const recoveryKey = resolveReplyComposerDraftKey({
    serverId,
    workspaceId: pane.workspaceId,
    agentId,
    target: Object.assign({}, target, { recoveryId: "old-submission" }),
  });
  const drafts = useDraftStore.getState();
  drafts.saveDraftInput({ draftKey, draft: { text: "Newer decision draft", attachments: [] } });
  try {
    await mountTopicConversation(client, true, 390, true);
    act(() => {
      store.updateSessionServerInfo(serverId, {
        serverId,
        hostname: null,
        version: null,
        features: { workspaceTopicThreads: true, workspaceButlerV1: true },
      });
      store.setQueuedMessages(
        serverId,
        new Map([
          [
            agentId,
            [
              {
                id: "old-decision",
                text: "Old reply",
                attachments: [{ kind: "quote", id: "preserved", text: "Original context" }],
                topicReply: {
                  workspaceId: pane.workspaceId,
                  target,
                  clientMessageId: "old-submission",
                },
              },
            ],
          ],
        ]),
      );
      useTopicStreamViewStore
        .getState()
        .setActiveReplyTopic(buildTopicAgentKey(serverId, agentId), target);
    });
    await userEvent.click(page.getByRole("button", { name: "Send queued message now" }));
    await expect
      .element(page.getByRole("button", { name: "Review unsent decision" }))
      .toBeVisible();
    await expect.element(page.getByRole("textbox")).toHaveValue("Newer decision draft");
    expect(useSessionStore.getState().sessions[serverId]?.queuedMessages.get(agentId)).toEqual([]);
    await userEvent.click(page.getByRole("button", { name: "Review unsent decision" }));
    await expect.element(page.getByRole("textbox")).toHaveValue("Old reply");
    await expect
      .element(page.getByTestId("composer-quote-card"))
      .toHaveTextContent("Original context");
    await expect
      .element(page.getByTestId("compact-topic-reply-context"))
      .toHaveTextContent("Should we change the rollout?");
    await page.getByRole("textbox").fill("Edited recovery");
    await vi.waitFor(() => expect(drafts.getDraftInput(recoveryKey)?.text).toBe("Edited recovery"));
    expect(drafts.getDraftInput(draftKey)?.text).toBe("Newer decision draft");
    expect(
      useTopicStreamViewStore.getState().activeReplyTopicByAgentKey[
        buildTopicAgentKey(serverId, agentId)
      ]?.decisionContext?.blockingQuestionGeneration,
    ).toBe(newGeneration);
    expect(decide).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        clientMessageId: "old-submission",
        expectedBlockingQuestionGeneration: "old",
      }),
    );
  } finally {
    drafts.clearDraftInput({ draftKey, lifecycle: "abandoned" });
    drafts.clearDraftInput({ draftKey: recoveryKey, lifecycle: "abandoned" });
    useDecisionRecoveryStore
      .getState()
      .remove(buildDecisionRecoveryScope(serverId, pane.workspaceId, agentId), "old-submission");
  }
});

it("sends queued topic A and an ordinary message to their own targets while B is selected", async () => {
  const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
  const sendOrdinary = vi.spyOn(client, "sendAgentMessage").mockResolvedValue({});
  const reply = vi.spyOn(client, "replyWorkspaceTopic").mockResolvedValue({
    requestId: "request",
    workspaceId: pane.workspaceId,
    topicKey: "msg:a",
    routedTo: "main",
    targetAgentId: agentId,
    entry: null,
    error: null,
  });
  const draftKey = buildTopicReplyDraftKey({
    serverId,
    workspaceId: pane.workspaceId,
    agentId,
    topicKey: "msg:a",
  });
  useDraftStore
    .getState()
    .saveDraftInput({ draftKey, draft: { text: "Queued for topic A", attachments: [] } });
  await mountTopicConversation(client, true, 390, true);
  await userEvent.click(page.getByTestId("topic-inline-reply-compact-msg:a"));
  await userEvent.click(page.getByRole("button", { name: "Queue message", exact: true }));
  expect(reply).not.toHaveBeenCalled();
  await userEvent.click(page.getByTestId("topic-inline-reply-compact-msg:b"));
  await userEvent.click(page.getByRole("button", { name: "Send queued message now" }));
  expect(reply).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      topicKey: "msg:a",
      rootMessageId: "a",
      text: "Queued for topic A",
      clientMessageId: expect.any(String),
    }),
  );
  expect(view.getByTestId("compact-topic-reply-context").textContent).toContain("Topic b");

  await userEvent.click(page.getByTestId("compact-topic-reply-cancel"));
  await page.getByRole("textbox").fill("Queued for the main conversation");
  await userEvent.click(page.getByRole("button", { name: "Queue message", exact: true }));
  expect(sendOrdinary).not.toHaveBeenCalled();
  await userEvent.click(page.getByTestId("topic-inline-reply-compact-msg:b"));
  await userEvent.click(page.getByRole("button", { name: "Send queued message now" }));
  await vi.waitFor(() =>
    expect(sendOrdinary).toHaveBeenCalledExactlyOnceWith(
      agentId,
      "Queued for the main conversation",
      expect.objectContaining({ activeTurnBehavior: "interrupt" }),
    ),
  );
  expect(reply).toHaveBeenCalledTimes(1);
});

it.each(["the historical report", "the composer"])(
  "keeps a new conclusion after a historical jump until the user clicks %s",
  async (clickTarget) => {
    const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
    const clearAgentAttention = vi
      .spyOn(client, "clearAgentAttention")
      .mockResolvedValue(undefined);
    const snapshot: HostRuntimeSnapshot = {
      serverId,
      client,
      connectionStatus: "online",
      activeConnectionId: null,
      activeConnection: null,
      lastError: null,
      lastOnlineAt: null,
      agentDirectoryStatus: "ready",
      agentDirectoryError: null,
      hasEverLoadedAgentDirectory: true,
      probeByConnectionId: new Map(),
      clientGeneration: 0,
      connectionEpoch: 0,
    };
    const runtime = getHostRuntimeStore();
    const getSnapshot = runtime.getSnapshot.bind(runtime);
    vi.spyOn(runtime, "getSnapshot").mockImplementation((id) =>
      id === serverId ? snapshot : getSnapshot(id),
    );
    store.initializeSession(serverId, client);
    const settings = new QueryClient();
    settings.setQueryData(APP_SETTINGS_QUERY_KEY, DEFAULT_APP_SETTINGS);
    const jumpStore = createTeamMessageJumpStore();
    const acknowledgeJump = vi.spyOn(jumpStore, "acknowledgeJump");
    const requestId = jumpStore.requestJump({
      serverId,
      agentId,
      itemId: "old-report",
      messageId: "old-report",
      epoch: null,
      seq: null,
    });
    const reportText = "A historical report from the reviewer";
    container.style.height = "620px";
    publishAgent(true);
    store.applyAgentTimelineResponseState(serverId, agentId, {
      items: [
        {
          kind: "user_message",
          id: "old-report",
          messageId: "old-report",
          text: reportText,
          timestamp: new Date("2026-04-20T00:00:00.000Z"),
        },
      ],
      head: [],
      range: null,
      older: "none",
      newer: false,
      synchronized: true,
      acknowledgedClientMessageIds: [],
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={settings}>
          <ConversationShell>
            <TeamMessageJumpProvider store={jumpStore}>
              <ConversationPane>
                <AgentConversationPanel />
              </ConversationPane>
            </TeamMessageJumpProvider>
          </ConversationShell>
        </QueryClientProvider>,
      ),
    );

    await vi.waitFor(() => expect(acknowledgeJump).toHaveBeenCalledExactlyOnceWith(requestId));
    await act(async () => publishAgent(true, undefined, true));
    const input = view.getByRole("textbox");
    await act(async () => {
      input.blur();
      input.focus();
    });
    expect(document.activeElement).toBe(input);
    expect(clearAgentAttention).not.toHaveBeenCalled();

    await userEvent.click(
      clickTarget === "the composer" ? page.getByRole("textbox") : page.getByText(reportText),
    );
    expect(clearAgentAttention).toHaveBeenCalledExactlyOnceWith(agentId);
  },
);

it("gates the inbox and summarizes distinct sources from the current snapshot", () => {
  initializeSession();
  publishAgent(true, inbox);
  renderInbox();
  expect(view.queryByTestId("pending-subagent-inbox-rail")).toBeNull();

  act(() => {
    publishAgent(false, inbox);
    enableInbox();
  });
  expect(view.queryByTestId("pending-subagent-inbox")).toBeNull();

  act(() => publishAgent(true, { count: 0, items: [] }));
  expect(view.queryByTestId("pending-subagent-inbox")).toBeNull();

  act(() => publishAgent(true, inbox));
  expect(view.getByText("2 pending reports")).toBeTruthy();
  expect(view.getByText("Reviewer, subagent…")).toBeTruthy();

  act(() =>
    publishAgent(true, {
      count: 6,
      items: [
        { agentId: "reviewer", title: "Outdated title", event: "finished" },
        { agentId: "reviewer", title: "  Reviewer  ", event: "finished" },
        { agentId: "subagent-1234567890", event: "finished" },
        { agentId: "other", serverId: "remote", title: "Remote", event: "finished" },
        { agentId: "other", title: "Local", event: "finished" },
        { agentId: "writer", event: "finished" },
      ],
    }),
  );
  expect(view.getByText("6 pending reports")).toBeTruthy();
  expect(
    view.getByText("Reviewer, subagent…, Remote +2", { normalizer: (text: string) => text }),
  ).toBeTruthy();
  act(() => publishAgent(true));
  expect(view.queryByTestId("pending-subagent-inbox-rail")).toBeNull();
});

it("retains the pending request and retry error while the inbox is hidden", async () => {
  const rejected = Promise.withResolvers<void>();
  const retried = Promise.withResolvers<void>();
  const flushAgentInbox = vi
    .fn<DaemonClient["flushAgentInbox"]>()
    .mockReturnValueOnce(rejected.promise)
    .mockReturnValueOnce(retried.promise);
  initializeSession(flushAgentInbox);
  enableInbox();
  publishAgent(true, inbox);
  renderInbox();

  const button = view.getByRole("button", { name: "Summarize now" });
  act(() => {
    button.click();
    button.click();
  });
  expect(flushAgentInbox).toHaveBeenCalledExactlyOnceWith(agentId);
  expect(view.getByRole("button", { name: "Summarizing…" })).toHaveProperty("disabled", true);

  renderInbox(true);
  expect(view.queryByTestId("pending-subagent-inbox-rail")).toBeNull();
  renderInbox();
  const summarizing = view.getByRole("button", { name: "Summarizing…" });
  expect(summarizing).toHaveProperty("disabled", true);
  act(() => summarizing.click());
  expect(flushAgentInbox).toHaveBeenCalledExactlyOnceWith(agentId);

  await act(async () => rejected.reject(new Error("Connection lost")));
  const alert = view.getByRole("alert");
  expect(alert.textContent).toContain("Retry");
  expect(getComputedStyle(alert).getPropertyValue("-webkit-line-clamp")).toBe("2");
  renderInbox(true);
  expect(view.queryByRole("alert")).toBeNull();
  renderInbox();
  expect(view.getByRole("alert").textContent).toContain("Retry");

  const retry = view.getByRole("button", { name: "Summarize now" });
  expect(retry).toHaveProperty("disabled", false);
  act(() => retry.click());
  expect(flushAgentInbox).toHaveBeenCalledTimes(2);
  expect(view.queryByRole("alert")).toBeNull();
  await act(async () => retried.resolve());
  expect(view.getByRole("button", { name: "Summarize now" })).toHaveProperty("disabled", false);
});

function expectColumnsToAlign(card: HTMLElement, reference: HTMLElement) {
  const bounds = card.getBoundingClientRect();
  const expected = reference.getBoundingClientRect();
  expect(bounds.left).toBeCloseTo(expected.left);
  expect(bounds.right).toBeCloseTo(expected.right);
  expect(bounds.width).toBeCloseTo(expected.width);
}

it("aligns the topic cards, tracks and composer while reserving the gutter in the timeline", async () => {
  const client = new DaemonClient({ url: "ws://unused.test", clientId: serverId });
  const width = CHAT_OUTLINE_MIN_PANEL_WIDTH + 2;
  await mountTopicConversation(client, true, width, false, [], true, { chatOutline: true });
  await userEvent.click(page.getByRole("button", { name: "Hide team directory" }));

  const railSelector = '[data-chat-rail-lane="true"]';
  const topicCard = () => view.getByTestId("topic-thread-card-msg:a");
  const tracks = () => view.getByTestId("composer-track-scroll");
  const composerRail = () => {
    const input: HTMLElement = view.getByRole("textbox", { name: "Message agent..." });
    return input.closest<HTMLElement>(railSelector)!;
  };
  const expectTopicColumns = (expectedWidth: number) => {
    const card = topicCard();
    const rail = composerRail();
    expect(rail.closest('[data-chat-rail-active="true"]')).toBeNull();
    expect(getComputedStyle(rail).paddingLeft).toBe("16px");
    expect(getComputedStyle(tracks().closest(railSelector)!).paddingLeft).toBe("16px");
    expectColumnsToAlign(card, rail.firstElementChild as HTMLElement);
    expectColumnsToAlign(card, tracks().closest(railSelector)!.firstElementChild as HTMLElement);
    expect(card.getBoundingClientRect().width).toBeCloseTo(expectedWidth);
  };

  expectTopicColumns(DEFAULT_CONTENT_MAX_WIDTH);
  await userEvent.click(page.getByTestId("topic-stream-mode-timeline"));
  await vi.waitFor(() => {
    expect(view.queryByTestId("topic-stream-list")).toBeNull();
    expect(getComputedStyle(composerRail()).paddingLeft).toBe(
      `${16 + CHAT_OUTLINE_GUTTER_INSET}px`,
    );
    expect(getComputedStyle(tracks().closest(railSelector)!).paddingLeft).toBe(
      `${16 + CHAT_OUTLINE_GUTTER_INSET}px`,
    );
  });

  await userEvent.click(page.getByTestId("topic-stream-mode-topics"));
  container.style.width = "420px";
  await vi.waitFor(() => expectTopicColumns(420 - 32));

  container.style.width = `${width}px`;
  container.style.setProperty("--test-content-max-width", "100%");
  await vi.waitFor(() => expectTopicColumns(width - 32));
});

it("aligns to the shared chat column with and without the outline gutter", async () => {
  initializeSession();
  enableInbox({ outline: true });
  const title = "A report from an agent with a title that is too long for the available space";
  publishAgent(true, { count: 1, items: [{ agentId: "reviewer", title, event: "finished" }] });
  const settings = new QueryClient();
  settings.setQueryData(APP_SETTINGS_QUERY_KEY, {
    ...DEFAULT_APP_SETTINGS,
    chatOutlineEnabled: true,
  });
  // Just above the outline threshold, the reserved gutter shifts the column off center.
  container.style.width = `${CHAT_OUTLINE_MIN_PANEL_WIDTH + 2}px`;
  await act(async () =>
    root.render(
      <QueryClientProvider client={settings}>
        <ToastProvider>
          <ChatColumnRailSurface serverId={serverId}>
            <View style={styles.referenceRail} dataSet={CHAT_COLUMN_RAIL_DATASET}>
              <View style={styles.referenceCard} testID="reference-card" />
            </View>
            <PendingSubagentInboxBar serverId={serverId} agentId={agentId} />
          </ChatColumnRailSurface>
        </ToastProvider>
      </QueryClientProvider>,
    ),
  );
  try {
    const rail = view.getByTestId("pending-subagent-inbox-rail");
    const card = view.getByTestId("pending-subagent-inbox");
    const reference = view.getByTestId("reference-card");
    const surface = rail.parentElement;
    const railStyle = getComputedStyle(rail);
    const cardStyle = getComputedStyle(card);
    expect(surface?.getAttribute("data-chat-rail-active")).toBe("true");
    expect(rail.getAttribute("data-chat-rail-lane")).toBe("true");
    expect(rail.contains(card)).toBe(true);
    expect(railStyle.alignItems).toBe("center");
    const expectedWideGutter = 16 + CHAT_OUTLINE_GUTTER_INSET;
    expect(railStyle.paddingLeft).toBe(`${expectedWideGutter}px`);
    expect(parseFloat(railStyle.paddingRight)).toBeLessThan(expectedWideGutter);
    expect(cardStyle.flexDirection).toBe("row");
    expect(cardStyle.borderTopLeftRadius).toBe("12px");
    expect(cardStyle.borderTopWidth).toBe("1px");
    expect(cardStyle.backgroundColor).toBe("rgb(250, 250, 250)");
    expect(card.getBoundingClientRect().width).toBeCloseTo(DEFAULT_CONTENT_MAX_WIDTH);
    expectColumnsToAlign(card, reference);

    container.style.width = "420px";
    await vi.waitFor(() => expect(surface?.hasAttribute("data-chat-rail-active")).toBe(false));
    const narrowRailRect = rail.getBoundingClientRect();
    const narrowCardRect = card.getBoundingClientRect();
    expect(narrowCardRect.left - narrowRailRect.left).toBeCloseTo(16);
    expect(narrowRailRect.right - narrowCardRect.right).toBeCloseTo(16);
    expectColumnsToAlign(card, reference);

    container.style.width = "280px";
    expectColumnsToAlign(card, reference);
    const sources = view.getByText(title);
    const pendingLabel = view.getByText("1 pending reports");
    const button = view.getByRole("button", { name: "Summarize now" });
    const label = within(button).getByText("Summarize now");
    expect(sources.clientWidth).toBeGreaterThan(0);
    expect(sources.scrollWidth).toBeGreaterThan(sources.clientWidth);
    expect(getComputedStyle(sources).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(pendingLabel).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(pendingLabel).whiteSpace).toBe("nowrap");
    const buttonStyle = getComputedStyle(button);
    expect(buttonStyle.flexShrink).toBe("0");
    expect(buttonStyle.backgroundColor).toBe("rgb(228, 228, 231)");
    expect(buttonStyle.paddingLeft).toBe("12px");
    expect(getComputedStyle(label).whiteSpace).toBe("nowrap");
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
    expect(button.getBoundingClientRect().right).toBeLessThan(card.getBoundingClientRect().right);
    expect(card.getBoundingClientRect().right).toBeLessThan(
      container.getBoundingClientRect().right,
    );
  } finally {
    settings.clear();
  }
});

const styles = StyleSheet.create((theme) => ({
  referenceRail: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  referenceCard: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
}));
