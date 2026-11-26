/** @vitest-environment jsdom */
import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import type { TopicThreadEntry } from "@getpaseo/protocol/messages";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSidebarAttention } from "@/components/sidebar/sidebar-unread-conclusions";
import { queryClient as sharedQueryClient } from "@/data/query-client";
import { submitActiveTopicReply } from "./submit-topic-reply";
import { PaneProvider, type PaneContextValue } from "@/panels/pane-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { buildTopicAgentKey, useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import {
  createTeamMessageJumpStore,
  TeamMessageJumpProvider,
} from "@/subagents/team-directory/message-jump-store";
import { workspaceTopicEntriesQueryKey } from "@/topic-threads/queries";
import type { StreamItem } from "@/types/stream";
import {
  topicMatchesScrollTarget,
  TopicStreamList,
  TopicStreamTopBar,
  useTopicStreamMarkAllRead,
} from "./topic-stream-list";

vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: "en" } }),
}));

vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/utils/app-visibility", () => ({
  getIsAppVisible: () => true,
  getIsAppActivelyVisible: () => true,
}));

vi.mock("@/utils/encode-images", () => ({
  encodeImages: vi.fn(async () => []),
}));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: vi.fn(),
}));

vi.mock("@/durable-items/queries", () => ({
  useWorkspaceDurableItems: () => ({
    result: { data: [] },
    online: true,
  }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    testID,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} onClick={onSelect}>
      {children}
    </button>
  ),
}));

const SERVER_ID = "srv-list-1";
const WORKSPACE_ID = "ws-list-1";
const MAIN_AGENT_ID = "mc-list-1";

function seedSession(options: {
  supportsTopicThreads: boolean;
  supportsTopicReadState: boolean;
  requiresAttention?: boolean;
}) {
  const agents = new Map([
    [
      MAIN_AGENT_ID,
      {
        id: MAIN_AGENT_ID,
        workspaceId: WORKSPACE_ID,
        parentAgentId: null,
        title: "Main Control",
        status: "idle",
        requiresAttention: options.requiresAttention ?? false,
        attentionReason: options.requiresAttention ? "finished" : null,
        labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
        updatedAt: new Date(5_000),
      },
    ],
    [
      "lead-1",
      {
        id: "lead-1",
        workspaceId: WORKSPACE_ID,
        parentAgentId: MAIN_AGENT_ID,
        title: "Backend Lead",
        status: "idle",
        updatedAt: new Date(5_000),
      },
    ],
  ]);

  useSessionStore.setState({
    sessions: {
      [SERVER_ID]: {
        agents,
        agentDetails: new Map(),
        agentAuthoritativeHistoryApplied: new Map([[MAIN_AGENT_ID, true]]),
        agentTimelineCursor: new Map([[MAIN_AGENT_ID, { epoch: "ep-1", startSeq: 1, endSeq: 10 }]]),
        agentTimelineHasOlder: new Map([[MAIN_AGENT_ID, false]]),
        agentTimelineHasNewer: new Map([[MAIN_AGENT_ID, false]]),
        agentStreamHead: new Map(),
        agentStreamTail: new Map(),
        agentTimelineOlderFetchInFlight: new Map(),
        pendingPermissions: new Map(),
        workspaces: new Map(),
        serverInfo: {
          features: {
            workspaceTopicThreads: options.supportsTopicThreads,
            workspaceTopicReadState: options.supportsTopicReadState,
            workspaceTaskLedger: false,
            workspaceTodos: false,
          },
        },
      },
    } as never,
  });
}

function makeStreamItems(): StreamItem[] {
  return [
    {
      kind: "user_message",
      id: "u-1",
      messageId: "m-1",
      text: "Check API latency spike",
      timestamp: new Date(1_000),
      timelineCursor: { epoch: "ep-1", seq: 1 },
    },
    {
      kind: "assistant_message",
      id: "a-1",
      messageId: "a-1",
      text: "Investigating now",
      timestamp: new Date(2_000),
      timelineCursor: { epoch: "ep-1", seq: 2 },
    },
  ];
}

function makePaneContextValue(): PaneContextValue {
  return {
    host: "main",
    serverId: SERVER_ID,
    workspaceId: WORKSPACE_ID,
    tabId: "tab-1",
    target: { kind: "agent", agentId: MAIN_AGENT_ID },
    openTab: vi.fn(),
    openPreferredTarget: vi.fn(),
    closeCurrentTab: vi.fn(),
    retargetCurrentTab: vi.fn(),
    setCurrentTabState: vi.fn(),
    openFileInWorkspace: vi.fn(),
    openImportSheet: vi.fn(),
  };
}

function TestTopBarHarness({ streamItems }: { streamItems: readonly StreamItem[] }) {
  const { totalUnreadTopics, markAllRead } = useTopicStreamMarkAllRead({
    serverId: SERVER_ID,
    workspaceId: WORKSPACE_ID,
    mainAgentId: MAIN_AGENT_ID,
    streamItems,
    streamHead: [],
  });
  return (
    <TopicStreamTopBar
      serverId={SERVER_ID}
      workspaceId={WORKSPACE_ID}
      mainAgentId={MAIN_AGENT_ID}
      viewMode="topics"
      unreadOnly={false}
      totalUnreadTopics={totalUnreadTopics}
      onChangeViewMode={vi.fn()}
      onToggleUnreadOnly={vi.fn()}
      onMarkAllRead={markAllRead}
      onOpenAddTodo={vi.fn()}
    />
  );
}

describe("TopicStreamList & read-watermark integration", () => {
  beforeEach(() => {
    useTopicStreamViewStore.setState({
      viewModeByAgentKey: {},
      unreadOnlyByAgentKey: {},
      expandedProcessByTopicKey: {},
      expandedHistoryByTopicKey: {},
      activeReplyTopicByAgentKey: {},
      pendingScrollTopicByAgentKey: {},
      returnTopicAnchorByAgentKey: {},
      todoEditorRequest: null,
    });
    sharedQueryClient.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("mounts the full TopicStreamList canvas with real Zustand 5 stores without unstable snapshot loops", () => {
    seedSession({ supportsTopicThreads: true, supportsTopicReadState: true });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <PaneProvider value={makePaneContextValue()}>
          <TopicStreamList
            serverId={SERVER_ID}
            workspaceId={WORKSPACE_ID}
            mainAgentId={MAIN_AGENT_ID}
            streamItems={makeStreamItems()}
            streamHead={[]}
            pendingPermissions={[]}
            isTurnActive={false}
            isPaneFocused={true}
          />
        </PaneProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("topic-stream-list")).toBeTruthy();
    expect(screen.getByTestId("topic-thread-card-msg:m-1")).toBeTruthy();
    expect(screen.getByTestId("topic-card-root-prompt").textContent).toBe(
      "Check API latency spike",
    );
    const snapshotWarnings = consoleErrorSpy.mock.calls.filter((args) =>
      String(args[0] ?? "").includes("getSnapshot"),
    );
    expect(snapshotWarnings).toHaveLength(0);
  });

  it("does not prematurely acknowledge pendingScroll before card layout is measured, and clears unreadOnly to reveal target", () => {
    seedSession({ supportsTopicThreads: true, supportsTopicReadState: true });
    const agentKey = buildTopicAgentKey(SERVER_ID, MAIN_AGENT_ID);
    useTopicStreamViewStore.getState().setUnreadOnly(agentKey, true);
    useTopicStreamViewStore.getState().requestScrollToTopic(agentKey, "msg:m-1", true);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PaneProvider value={makePaneContextValue()}>
          <TopicStreamList
            serverId={SERVER_ID}
            workspaceId={WORKSPACE_ID}
            mainAgentId={MAIN_AGENT_ID}
            streamItems={makeStreamItems()}
            streamHead={[]}
            pendingPermissions={[]}
            isTurnActive={false}
            isPaneFocused={true}
          />
        </PaneProvider>
      </QueryClientProvider>,
    );

    // Since card layout has NOT been measured yet in jsdom, pendingScroll MUST stay pending!
    expect(
      useTopicStreamViewStore.getState().pendingScrollTopicByAgentKey[agentKey],
    ).not.toBeNull();
    // And unreadOnly was turned off so the target card is mounted.
    expect(useTopicStreamViewStore.getState().unreadOnlyByAgentKey[agentKey]).toBe(false);
  });

  it("sends a real quoted message on legacy hosts and preserves draft when send fails", async () => {
    seedSession({ supportsTopicThreads: false, supportsTopicReadState: false });
    const sendAgentMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network down"))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
      connectionStatus: "online",
      client: { sendAgentMessage },
    } as never);
    const onErrorToast = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <PaneProvider value={makePaneContextValue()}>
          <TopicStreamList
            serverId={SERVER_ID}
            workspaceId={WORKSPACE_ID}
            mainAgentId={MAIN_AGENT_ID}
            streamItems={makeStreamItems()}
            streamHead={[]}
            pendingPermissions={[]}
            isTurnActive={false}
            isPaneFocused={true}
            onErrorToast={onErrorToast}
          />
        </PaneProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("topic-inline-reply-trigger-msg:m-1"));
    const input = screen.getByTestId("topic-inline-reply-input-msg:m-1");
    fireEvent.change(input, { target: { value: "Follow up on latency" } });

    const sendButton = screen.getByTestId("topic-inline-reply-send-msg:m-1");
    fireEvent.click(sendButton);

    await vi.waitFor(() => {
      expect(onErrorToast).toHaveBeenCalledWith("Network down");
      expect((sendButton as HTMLButtonElement).disabled).toBe(false);
    });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(sendAgentMessage.mock.calls[0]![1]).toContain("> Check API latency spike");
    expect(sendAgentMessage.mock.calls[0]![1]).toContain("Follow up on latency");

    // Clicking Send again re-submits the preserved draft and clears it once accepted.
    fireEvent.click(sendButton);
    await vi.waitFor(() => {
      expect(sendAgentMessage).toHaveBeenCalledTimes(2);
      expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("counts attention and cached thread entries in TopicStreamTopBar mark-all-read", () => {
    seedSession({
      supportsTopicThreads: true,
      supportsTopicReadState: true,
      requiresAttention: true,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const entries: TopicThreadEntry[] = [
      {
        entryId: "te-1",
        workspaceId: WORKSPACE_ID,
        mainAgentId: MAIN_AGENT_ID,
        topicKey: "msg:m-1",
        role: "agent_reply",
        routedAgentId: "lead-1",
        text: "New thread update",
        status: "completed",
        seq: 1,
        createdAt: new Date(9_000).toISOString(),
        updatedAt: new Date(9_000).toISOString(),
      },
    ];
    qc.setQueryData(workspaceTopicEntriesQueryKey(SERVER_ID, WORKSPACE_ID, MAIN_AGENT_ID), entries);

    render(
      <QueryClientProvider client={qc}>
        <TestTopBarHarness streamItems={makeStreamItems()} />
      </QueryClientProvider>,
    );

    const markAllBtn = screen.getByTestId("topic-stream-mark-all-read") as HTMLButtonElement;
    expect(markAllBtn.disabled).toBe(false);
  });

  it("submits per-workspace observed watermark snapshot in clearSidebarAttention without calling blind clearAgentAttention on topic main", async () => {
    seedSession({
      supportsTopicThreads: true,
      supportsTopicReadState: true,
      requiresAttention: true,
    });
    const markAllWorkspaceTopicsRead = vi.fn().mockResolvedValue({ snapshots: [], error: null });
    const clearAgentAttention = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
      connectionStatus: "online",
      client: { markAllWorkspaceTopicsRead, clearAgentAttention },
    } as never);

    await clearSidebarAttention([
      {
        kind: "finished",
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        workspaceKey: `${SERVER_ID}:${WORKSPACE_ID}`,
        agentId: MAIN_AGENT_ID,
        title: "Main Control",
        workspaceName: "Topic WS",
        projectName: "Paseo",
        timestampMs: 8_000,
      },
      {
        kind: "permission",
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        workspaceKey: `${SERVER_ID}:${WORKSPACE_ID}`,
        agentId: "perm-agent",
        title: "Needs approval",
        workspaceName: "Topic WS",
        projectName: "Paseo",
        timestampMs: 9_000,
      },
    ]);

    expect(markAllWorkspaceTopicsRead).toHaveBeenCalledTimes(1);
    expect(markAllWorkspaceTopicsRead).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        mainAgentId: MAIN_AGENT_ID,
        epoch: "ep-1",
        maxSeq: 10,
        maxTimestampMs: 8_000,
      }),
    );
    expect(clearAgentAttention).not.toHaveBeenCalled();
  });

  it("forwards attachments on compact topic replies via workspace.topic.reply and via quoted send on legacy hosts", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const replyWorkspaceTopic = vi.fn().mockResolvedValue({
      routedTo: "lead",
      targetAgentId: "lead-1",
      entry: null,
      error: null,
    });
    const sendAgentMessage = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
      connectionStatus: "online",
      client: { replyWorkspaceTopic, sendAgentMessage },
    } as never);

    const fileAttachment = {
      kind: "file" as const,
      attachment: {
        type: "uploaded_file" as const,
        id: "upload-1",
        path: "/tmp/trace.log",
        fileName: "trace.log",
        mimeType: "text/plain",
        size: 128,
      },
    };
    const activeReplyTopic = {
      topicKey: "task:T-9",
      taskId: "T-9",
      rootMessageId: "m-9",
      leadAgentId: "lead-1",
      leadTitle: "Backend Lead",
      promptPreview: "Investigate trace",
      routeMode: "auto" as const,
    };

    const sentNewHost = await submitActiveTopicReply({
      queryClient: qc,
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: MAIN_AGENT_ID,
      activeReplyTopic,
      payload: { text: "See attached trace", attachments: [fileAttachment], cwd: "/repo" },
      supportsTopicThreads: true,
      supportsForgeAttachments: true,
      disconnectedMessage: "Host disconnected",
    });

    expect(sentNewHost).toBe(true);
    expect(replyWorkspaceTopic).toHaveBeenCalledWith(
      expect.objectContaining({
        topicKey: "task:T-9",
        text: "See attached trace",
        attachments: [fileAttachment.attachment],
      }),
    );

    const sentLegacyHost = await submitActiveTopicReply({
      queryClient: qc,
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: MAIN_AGENT_ID,
      activeReplyTopic,
      payload: { text: "Legacy follow-up", attachments: [fileAttachment], cwd: "/repo" },
      supportsTopicThreads: false,
      supportsForgeAttachments: true,
      disconnectedMessage: "Host disconnected",
    });

    expect(sentLegacyHost).toBe(true);
    expect(sendAgentMessage).toHaveBeenCalledWith(
      MAIN_AGENT_ID,
      expect.stringContaining("> Investigate trace"),
      expect.objectContaining({
        attachments: [fileAttachment.attachment],
      }),
    );

    // Retrying compact topic reply with identical draft reuses the persisted clientMessageId.
    let persistedSig: string | undefined;
    let persistedId: string | undefined;
    const persistIntent = (sig: string, id: string) => {
      persistedSig = sig;
      persistedId = id;
    };
    replyWorkspaceTopic.mockReset();
    replyWorkspaceTopic.mockRejectedValueOnce(new Error("Dropped ACK")).mockResolvedValueOnce({
      routedTo: "lead",
      targetAgentId: "lead-1",
      entry: null,
      error: null,
    });

    await expect(
      submitActiveTopicReply({
        queryClient: qc,
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        agentId: MAIN_AGENT_ID,
        activeReplyTopic,
        payload: { text: "Idempotent compact retry", attachments: [], cwd: "/repo" },
        supportsTopicThreads: true,
        supportsForgeAttachments: true,
        disconnectedMessage: "Host disconnected",
        onPersistSubmissionIntent: persistIntent,
      }),
    ).rejects.toThrow("Dropped ACK");

    expect(persistedId).toBeTruthy();
    await submitActiveTopicReply({
      queryClient: qc,
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: MAIN_AGENT_ID,
      activeReplyTopic: {
        ...activeReplyTopic,
        pendingSubmissionSignature: persistedSig,
        pendingClientMessageId: persistedId,
      },
      payload: { text: "Idempotent compact retry", attachments: [], cwd: "/repo" },
      supportsTopicThreads: true,
      supportsForgeAttachments: true,
      disconnectedMessage: "Host disconnected",
      onPersistSubmissionIntent: persistIntent,
    });
    expect(replyWorkspaceTopic.mock.calls[0]![0].clientMessageId).toBe(persistedId);
    expect(replyWorkspaceTopic.mock.calls[1]![0].clientMessageId).toBe(persistedId);
  });

  it("matches msg:<root> scroll targets after topic upgrades to task:<id> and preserves jumps during cold start", () => {
    // 1) Multi-key equivalence: topic bound to task:T-42 still matches legacy msg:m-42 target!
    expect(
      topicMatchesScrollTarget(
        {
          topicKey: "task:T-42",
          taskId: "T-42",
          rootItemId: "u-42",
          rootMessageId: "m-42",
          rootPrompt: {
            id: "u-42",
            messageId: "m-42",
            text: "Upgrade test",
            timestampMs: 1_000,
            seq: 1,
            epoch: "ep-1",
            item: null,
          },
          task: null,
          processSteps: [],
          replies: [],
          pendingInboxItems: [],
          linkedTodos: [],
          linkedDurableItems: [],
          linkedPermissions: [],
          unreadReplyCount: 0,
          firstUnreadReplyIndex: null,
          isMarkedUnread: false,
          hasUnread: false,
          latestSeq: 1,
          latestTimestampMs: 1_000,
          latestEpoch: "ep-1",
          lifecycleStatus: "settled",
          retryCandidate: null,
        },
        { topicKey: "msg:m-42" },
      ),
    ).toBe(true);

    // 2) Cold start (timeline not yet synced): pending scroll for an unloaded topic MUST NOT be dropped!
    seedSession({ supportsTopicThreads: true, supportsTopicReadState: true });
    useSessionStore.setState((prev) => ({
      sessions: {
        ...prev.sessions,
        [SERVER_ID]: {
          ...prev.sessions[SERVER_ID]!,
          agentAuthoritativeHistoryApplied: new Map([[MAIN_AGENT_ID, false]]),
          agentTimelineHasOlder: new Map([[MAIN_AGENT_ID, false]]),
        },
      },
    }));
    const agentKey = buildTopicAgentKey(SERVER_ID, MAIN_AGENT_ID);
    useTopicStreamViewStore.getState().requestScrollToTopic(agentKey, "task:T-UNLOADED", true);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PaneProvider value={makePaneContextValue()}>
          <TopicStreamList
            serverId={SERVER_ID}
            workspaceId={WORKSPACE_ID}
            mainAgentId={MAIN_AGENT_ID}
            streamItems={[]}
            streamHead={[]}
            pendingPermissions={[]}
            isTurnActive={false}
            isPaneFocused={true}
          />
        </PaneProvider>
      </QueryClientProvider>,
    );

    expect(
      useTopicStreamViewStore.getState().pendingScrollTopicByAgentKey[agentKey]?.topicKey,
    ).toBe("task:T-UNLOADED");
  });

  it("keeps a team jump pending when the targeted history fetch fails and older pages remain", async () => {
    seedSession({ supportsTopicThreads: true, supportsTopicReadState: true });
    useSessionStore.setState((prev) => ({
      sessions: {
        ...prev.sessions,
        [SERVER_ID]: {
          ...prev.sessions[SERVER_ID]!,
          agentTimelineHasOlder: new Map([[MAIN_AGENT_ID, true]]),
          agentTimelineOlderFetchInFlight: new Map([[MAIN_AGENT_ID, true]]),
        },
      },
    }));
    const fetchTimeline = vi
      .spyOn(getHostRuntimeStore(), "fetchAgentTimeline")
      .mockRejectedValue(new Error("Connection dropped"));
    const jumps = createTeamMessageJumpStore();
    const requestId = jumps.requestJump({
      serverId: SERVER_ID,
      agentId: MAIN_AGENT_ID,
      itemId: "missing",
      messageId: null,
      epoch: "ep-1",
      seq: 0,
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <PaneProvider value={makePaneContextValue()}>
          <TeamMessageJumpProvider store={jumps}>
            <TopicStreamList
              serverId={SERVER_ID}
              workspaceId={WORKSPACE_ID}
              mainAgentId={MAIN_AGENT_ID}
              streamItems={[]}
              streamHead={[]}
              pendingPermissions={[]}
              isTurnActive={false}
              isPaneFocused={true}
            />
          </TeamMessageJumpProvider>
        </PaneProvider>
      </QueryClientProvider>,
    );

    await vi.waitFor(() => expect(fetchTimeline).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(jumps.getIntent()?.requestId).toBe(requestId);
  });

  it("keeps a direct jump pending after four automatic history pages", async () => {
    seedSession({ supportsTopicThreads: true, supportsTopicReadState: true });
    useSessionStore.setState((prev) => ({
      sessions: {
        ...prev.sessions,
        [SERVER_ID]: {
          ...prev.sessions[SERVER_ID]!,
          client: {} as never,
          agentTimelineHasOlder: new Map([[MAIN_AGENT_ID, true]]),
        },
      },
    }));
    const fetchTimeline = vi
      .spyOn(getHostRuntimeStore(), "fetchAgentTimeline")
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {} as never;
      });
    const agentKey = buildTopicAgentKey(SERVER_ID, MAIN_AGENT_ID);
    useTopicStreamViewStore.getState().requestScrollToTopic(agentKey, "task:past-cap", true);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <PaneProvider value={makePaneContextValue()}>
          <TopicStreamList
            serverId={SERVER_ID}
            workspaceId={WORKSPACE_ID}
            mainAgentId={MAIN_AGENT_ID}
            streamItems={[]}
            streamHead={[]}
            pendingPermissions={[]}
            isTurnActive={false}
            isPaneFocused={true}
          />
        </PaneProvider>
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      expect(fetchTimeline).toHaveBeenCalledTimes(4);
      expect(
        useSessionStore
          .getState()
          .sessions[SERVER_ID]?.agentTimelineOlderFetchInFlight.get(MAIN_AGENT_ID),
      ).toBe(false);
    });
    expect(
      useTopicStreamViewStore.getState().pendingScrollTopicByAgentKey[agentKey]?.topicKey,
    ).toBe("task:past-cap");
  });
});
