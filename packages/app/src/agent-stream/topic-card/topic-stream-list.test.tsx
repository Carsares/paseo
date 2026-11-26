/** @vitest-environment jsdom */
import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import type {
  TopicThreadEntry,
  WorkspaceDurableItem,
  WorkspaceTaskSummary,
  WorkspaceTopicDecideResponse,
} from "@getpaseo/protocol/messages";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSidebarAttention } from "@/components/sidebar/sidebar-unread-conclusions";
import { applyWorkspaceTasksUpdateToCache } from "@/composer/workspace-task-ledger/query";
import { queryClient as sharedQueryClient } from "@/data/query-client";
import { applyDurableItemUpdateToCache, durableItemsQueryKey } from "@/durable-items/queries";
import { submitActiveTopicReply, TopicDecisionStaleQuestionError } from "./submit-topic-reply";
import { PaneProvider, type PaneContextValue } from "@/panels/pane-context";
import { encodeImages } from "@/utils/encode-images";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { createWorkspaceSheetStack } from "@/screens/workspace/sheet-pane/stack";
import { useSessionStore } from "@/stores/session-store";
import { useTeamDirectoryViewStore } from "@/stores/team-directory-view-store";
import { buildTopicAgentKey, useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import {
  createTeamMessageJumpStore,
  TeamMessageJumpProvider,
} from "@/subagents/team-directory/message-jump-store";
import { TeamDirectoryShellProvider } from "@/subagents/team-directory/shell-context";
import { workspaceTopicReadQueryKey } from "@/topic-read/queries";
import { applyTopicAnchorToCache, workspaceTopicEntriesQueryKey } from "@/topic-threads/queries";
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

let mockIsCompactFormFactor = false;

vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => mockIsCompactFormFactor,
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
  supportsButlerV1?: boolean;
  supportsTaskLedger?: boolean;
  supportsDurableItems?: boolean;
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
            workspaceTaskLedger: options.supportsTaskLedger ?? false,
            workspaceDurableItemsV1: options.supportsDurableItems ?? false,
            workspaceTodos: false,
            ...(options.supportsButlerV1 !== undefined
              ? { workspaceButlerV1: options.supportsButlerV1 }
              : {}),
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

function makeTeamDirectoryShellValue(
  toggleDirectory: () => void,
  overrides?: {
    isOwnedByWorkspaceShell?: boolean;
    isDirectoryVisible?: boolean;
    openDirectory?: () => void;
  },
) {
  return {
    isOwnedByWorkspaceShell: overrides?.isOwnedByWorkspaceShell ?? true,
    isDirectoryVisible: overrides?.isDirectoryVisible ?? false,
    toggleDirectory,
    ...(overrides?.openDirectory ? { openDirectory: overrides.openDirectory } : {}),
  };
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
    mockIsCompactFormFactor = false;
    useTeamDirectoryViewStore.setState({ activeTab: "agents" });
    useTopicStreamViewStore.setState({
      viewModeByAgentKey: {},
      unreadOnlyByAgentKey: {},
      expandedProcessByTopicKey: {},
      expandedHistoryByTopicKey: {},
      expandedConflictsByTopicKey: {},
      decisionDraftByTopicKey: {},
      decisionDraftMetaByTopicKey: {},
      durableDecisionIntents: {},
      inlineReplyDrafts: {},
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

  it("restores the inline draft and transmission ID after unread filtering unmounts the card", async () => {
    seedSession({ supportsTopicThreads: true, supportsTopicReadState: false });
    const replyWorkspaceTopic = vi
      .fn()
      .mockRejectedValueOnce(new Error("Acknowledgement missing"))
      .mockResolvedValueOnce({ error: null, entry: null });
    vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
      connectionStatus: "online",
      client: { replyWorkspaceTopic },
    } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const agentKey = buildTopicAgentKey(SERVER_ID, MAIN_AGENT_ID);
    const onErrorToast = vi.fn();
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
    const inputId = "topic-inline-reply-input-msg:m-1";
    const sendId = "topic-inline-reply-send-msg:m-1";
    fireEvent.click(screen.getByTestId("topic-inline-reply-trigger-msg:m-1"));
    fireEvent.change(screen.getByTestId(inputId), { target: { value: "Preserve this answer" } });
    fireEvent.click(screen.getByTestId(sendId));
    await vi.waitFor(() => expect(onErrorToast).toHaveBeenCalledWith("Acknowledgement missing"));

    await act(async () => {
      useTopicStreamViewStore.getState().setUnreadOnly(agentKey, true);
    });
    expect(screen.queryByTestId(inputId)).toBeNull();
    await act(async () => {
      useTopicStreamViewStore.getState().setUnreadOnly(agentKey, false);
    });
    expect((screen.getByTestId(inputId) as HTMLTextAreaElement).value).toBe("Preserve this answer");
    fireEvent.click(screen.getByTestId(sendId));
    await vi.waitFor(() => expect(replyWorkspaceTopic).toHaveBeenCalledTimes(2));
    expect(replyWorkspaceTopic.mock.calls[1]?.[0]).toMatchObject({
      topicKey: "msg:m-1",
      text: "Preserve this answer",
      clientMessageId: replyWorkspaceTopic.mock.calls[0]?.[0]?.clientMessageId,
    });
  });

  it("marks a single card with the observed epoch and omits sequence from a different epoch", async () => {
    seedSession({ supportsTopicThreads: false, supportsTopicReadState: true });
    const markWorkspaceTopicRead = vi.fn().mockResolvedValue({ error: null, snapshot: null });
    vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
      connectionStatus: "online",
      client: { markWorkspaceTopicRead },
    } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(workspaceTopicReadQueryKey(SERVER_ID, WORKSPACE_ID, MAIN_AGENT_ID), {
      workspaceId: WORKSPACE_ID,
      mainAgentId: MAIN_AGENT_ID,
      watermarkEpoch: "ep-2",
      watermarkSeq: 0,
      watermarkTimestampMs: 0,
      topics: [],
      revision: 1,
    });
    const oldTopic = makeStreamItems();
    const currentTopic: StreamItem = {
      kind: "user_message",
      id: "new-prompt",
      messageId: "new-prompt",
      text: "Current history",
      timestamp: new Date(3000),
      timelineCursor: { epoch: "ep-2", seq: 1 },
    };
    render(
      <QueryClientProvider client={qc}>
        <PaneProvider value={makePaneContextValue()}>
          <TopicStreamList
            serverId={SERVER_ID}
            workspaceId={WORKSPACE_ID}
            mainAgentId={MAIN_AGENT_ID}
            streamItems={[...oldTopic, currentTopic]}
            streamHead={[]}
            pendingPermissions={[]}
            isTurnActive={false}
            isPaneFocused={true}
          />
        </PaneProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("topic-card-toggle-read-msg:m-1"));
    expect(markWorkspaceTopicRead).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        topicKey: "msg:m-1",
        epoch: "ep-2",
        timestampMs: 2000,
      }),
    );
    expect(markWorkspaceTopicRead.mock.calls[0]?.[0]).not.toHaveProperty("seq");
  });

  it("resends an unacknowledged retry with the same ID and allocates a new ID after definite refusal", async () => {
    seedSession({ supportsTopicThreads: true, supportsTopicReadState: false });
    const replyWorkspaceTopic = vi
      .fn()
      .mockRejectedValueOnce(new Error("No acknowledgement"))
      .mockResolvedValueOnce({ error: "Refused", entry: null })
      .mockResolvedValueOnce({ error: null, entry: null });
    vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
      connectionStatus: "online",
      client: { replyWorkspaceTopic },
    } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const entry: TopicThreadEntry = {
      entryId: "safe-entry",
      workspaceId: WORKSPACE_ID,
      mainAgentId: MAIN_AGENT_ID,
      role: "user_followup",
      topicKey: "msg:m-1",
      rootMessageId: "m-1",
      routedAgentId: MAIN_AGENT_ID,
      text: "[attachment]",
      status: "error",
      retryable: true,
      seq: 1,
      createdAt: new Date(3000).toISOString(),
      updatedAt: new Date(3000).toISOString(),
    };
    qc.setQueryData(workspaceTopicEntriesQueryKey(SERVER_ID, WORKSPACE_ID, MAIN_AGENT_ID), [
      entry,
      { ...entry, entryId: "unknown-entry", retryable: false, seq: 2 },
    ]);
    const onErrorToast = vi.fn();
    const list = (
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
      </QueryClientProvider>
    );
    const mounted = render(list);
    expect(screen.queryByTestId("topic-reply-retry-unknown-entry")).toBeNull();
    fireEvent.click(screen.getByTestId("topic-reply-retry-safe-entry"));
    await vi.waitFor(() => expect(onErrorToast).toHaveBeenCalledWith("No acknowledgement"));
    mounted.unmount();
    render(list);
    const retry = screen.getByTestId("topic-reply-retry-safe-entry");
    fireEvent.click(retry);
    await vi.waitFor(() => expect(onErrorToast).toHaveBeenCalledWith("Refused"));
    fireEvent.click(retry);
    await vi.waitFor(() => expect(replyWorkspaceTopic).toHaveBeenCalledTimes(3));
    const [first, resend, newAttempt] = replyWorkspaceTopic.mock.calls.map(([request]) => request);
    expect(first).toMatchObject({
      retryOfEntryId: "safe-entry",
      topicKey: "msg:m-1",
      text: "[attachment]",
    });
    expect(resend.clientMessageId).toBe(first.clientMessageId);
    expect(newAttempt.clientMessageId).not.toBe(first.clientMessageId);
  });

  it.each(["partial", "total", "decision"] as const)(
    "keeps attachments out of an incomplete topic send (%s)",
    async (failure) => {
      const replyWorkspaceTopic = vi.fn();
      const decideWorkspaceTopic = vi.fn();
      const uploadFile = vi.fn();
      vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
        connectionStatus: "online",
        client: { replyWorkspaceTopic, decideWorkspaceTopic, uploadFile },
      } as never);
      vi.mocked(encodeImages).mockResolvedValueOnce(
        failure === "partial" ? [{ data: "AA==", mimeType: "image/png" }] : [],
      );
      const attachments = ["first", "second"].map((id) => ({
        kind: "image" as const,
        metadata: {
          id,
          mimeType: "image/png",
          fileName: `${id}.png`,
          storageType: "web-indexeddb" as const,
          storageKey: id,
          createdAt: 0,
        },
      }));
      await expect(
        submitActiveTopicReply({
          queryClient: new QueryClient(),
          serverId: SERVER_ID,
          workspaceId: WORKSPACE_ID,
          agentId: MAIN_AGENT_ID,
          activeReplyTopic: {
            topicKey: "msg:m-1",
            promptPreview: "First question",
            routeMode: "auto",
            ...(failure === "decision"
              ? {
                  decisionContext: { kind: "task_blocking_question", question: "Approve?" },
                }
              : {}),
          },
          payload: { text: failure === "decision" ? "Yes" : "", attachments, cwd: "/repo" },
          supportsTopicThreads: true,
          supportsButlerV1: true,
          supportsForgeAttachments: true,
          disconnectedMessage: "offline",
        }),
      ).rejects.toThrow();
      expect(uploadFile).not.toHaveBeenCalled();
      expect(replyWorkspaceTopic).not.toHaveBeenCalled();
      expect(decideWorkspaceTopic).not.toHaveBeenCalled();
      if (failure === "decision") vi.mocked(encodeImages).mockReset().mockResolvedValue([]);
    },
  );

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
          fileConflicts: [],
          activeBlockingPrompt: null,
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

  it("renders anchor-restored cards with real-time pushed tasks, triggers conflict jump, and submits blocking decisions", async () => {
    seedSession({
      supportsTopicThreads: true,
      supportsTopicReadState: true,
      supportsTaskLedger: true,
      supportsButlerV1: true,
    });
    const decideWorkspaceTopic = vi.fn().mockResolvedValue({
      requestId: "req-dec-1",
      workspaceId: WORKSPACE_ID,
      topicKey: "task:T-pushed",
      durableItem: null,
      task: {
        taskId: "T-pushed",
        title: "Pushed topic",
        tier: "T2",
        status: "in_progress",
        participants: [{ agentId: "lead-1" }],
        leadAgentId: "lead-1",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:05:00.000Z",
      },
      routedTo: "lead",
      targetAgentId: "lead-1",
      entry: {
        entryId: "te-dec-1",
        workspaceId: WORKSPACE_ID,
        mainAgentId: MAIN_AGENT_ID,
        topicKey: "task:T-pushed",
        taskId: "T-pushed",
        role: "user_followup",
        origin: "decision_reply",
        routedAgentId: "lead-1",
        text: "Proceed with option A",
        status: "completed",
        seq: 1,
        createdAt: "2026-06-01T00:05:00.000Z",
        updatedAt: "2026-06-01T00:05:00.000Z",
      },
      error: null,
    });
    vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
      connectionStatus: "online",
      client: { decideWorkspaceTopic },
    } as never);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    applyTopicAnchorToCache(qc, SERVER_ID, {
      workspaceId: WORKSPACE_ID,
      mainAgentId: MAIN_AGENT_ID,
      anchor: {
        workspaceId: WORKSPACE_ID,
        mainAgentId: MAIN_AGENT_ID,
        topicKey: "task:T-pushed",
        taskId: "T-pushed",
        rootPromptText: "Restored topic after session reset",
        leadAgentId: "lead-1",
        leadTitle: "Backend Lead",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:01:00.000Z",
      },
    });
    applyTopicAnchorToCache(qc, SERVER_ID, {
      workspaceId: WORKSPACE_ID,
      mainAgentId: MAIN_AGENT_ID,
      anchor: {
        workspaceId: WORKSPACE_ID,
        mainAgentId: MAIN_AGENT_ID,
        topicKey: "task:T-peer-2",
        taskId: "T-peer-2",
        rootPromptText: "Peer topic modifying agent-panel",
        createdAt: "2026-06-01T00:00:30.000Z",
        updatedAt: "2026-06-01T00:01:00.000Z",
      },
    });
    applyWorkspaceTasksUpdateToCache(qc, SERVER_ID, {
      workspaceId: WORKSPACE_ID,
      tasks: [
        {
          taskId: "T-pushed",
          title: "Pushed topic",
          tier: "T2",
          status: "awaiting_decision",
          participants: [{ agentId: "lead-1" }],
          leadAgentId: "lead-1",
          blockingQuestion: "Pick next step:\n1. Proceed with option A\n2. Roll back",
          fileConflicts: [
            {
              path: "packages/app/src/panels/agent-panel.tsx",
              peers: [
                {
                  taskId: "T-peer-2",
                  title: "Peer topic",
                  status: "in_progress",
                },
              ],
            },
          ],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:02:00.000Z",
        },
      ],
    });

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

    expect(screen.getByTestId("topic-thread-card-task:T-pushed")).toBeTruthy();
    expect(screen.getByTestId("topic-thread-card-task:T-peer-2")).toBeTruthy();
    expect(screen.getAllByTestId("topic-card-root-prompt")[0]!.textContent).toBe(
      "Restored topic after session reset",
    );

    const agentKey = buildTopicAgentKey(SERVER_ID, MAIN_AGENT_ID);
    fireEvent.click(screen.getByTestId("topic-conflict-jump-T-peer-2"));
    expect(
      useTopicStreamViewStore.getState().pendingScrollTopicByAgentKey[agentKey]?.topicKey,
    ).toBe("task:T-peer-2");

    fireEvent.click(screen.getByTestId("topic-decision-option-0"));
    fireEvent.click(screen.getByTestId("topic-decision-submit-task:T-pushed"));

    await vi.waitFor(() => {
      expect(decideWorkspaceTopic).toHaveBeenCalledTimes(1);
    });
    expect(decideWorkspaceTopic).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        mainAgentId: MAIN_AGENT_ID,
        topicKey: "task:T-pushed",
        taskId: "T-pushed",
        resolutionKind: "task_blocking_question",
        note: "Proceed with option A",
      }),
    );

    // Compact decision submission via submitActiveTopicReply also routes to decideWorkspaceTopic.
    decideWorkspaceTopic.mockClear();
    await submitActiveTopicReply({
      queryClient: qc,
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: MAIN_AGENT_ID,
      activeReplyTopic: {
        topicKey: "task:T-pushed",
        taskId: "T-pushed",
        promptPreview: "Restored topic after session reset",
        routeMode: "auto",
        decisionContext: {
          kind: "task_blocking_question",
          taskId: "T-pushed",
          question: "Pick next step",
        },
      },
      payload: { text: "Compact decision answer", attachments: [], cwd: "/repo" },
      supportsTopicThreads: true,
      supportsButlerV1: true,
      supportsForgeAttachments: true,
      disconnectedMessage: "Host disconnected",
    });
    expect(decideWorkspaceTopic).toHaveBeenCalledWith(
      expect.objectContaining({
        resolutionKind: "task_blocking_question",
        note: "Compact decision answer",
      }),
    );
  });

  it.each([
    ["resume_required", null],
    ["lost_response", "The approval was recorded, but the task changed before follow-up delivery."],
  ] as const)(
    "resumes the original approval after the approval closes and a new question appears (%s)",
    async (firstOutcome, warning) => {
      seedSession({
        supportsTopicThreads: true,
        supportsTopicReadState: false,
        supportsTaskLedger: true,
        supportsDurableItems: true,
        supportsButlerV1: true,
      });
      const taskId = "T-resume";
      const topicKey = `task:${taskId}`;
      const createdAt = "2026-06-01T00:00:00.000Z";
      const updatedAt = "2026-06-01T00:01:00.000Z";
      const approval: WorkspaceDurableItem = {
        workspaceId: WORKSPACE_ID,
        requestId: "saved-approval",
        sourceAgentId: "lead-1",
        sourceTurnId: "turn-1",
        kind: "decision",
        title: "Approve original plan",
        evidence: [],
        createdAt,
        revision: 3,
        status: "pending",
        taskId,
        topicKey,
        rootMessageId: "m-1",
      };
      const approved: WorkspaceDurableItem = {
        ...approval,
        revision: 4,
        status: "decided",
        decision: "approve",
        note: "Original conditions",
        decidedAt: updatedAt,
      };
      const task: WorkspaceTaskSummary = {
        taskId,
        rootMessageId: "m-1",
        title: "Approval with a follow-up",
        tier: "T2",
        status: "awaiting_decision",
        participants: [{ agentId: "lead-1" }],
        leadAgentId: "lead-1",
        createdAt,
        updatedAt: createdAt,
      };
      const newQuestion: WorkspaceTaskSummary = {
        ...task,
        blockingQuestion: "How should we handle the new constraint?",
        blockingQuestionGeneration: "f5808620-b229-4dd4-9393-f07ce7892f0b",
        updatedAt,
      };
      const first = Promise.withResolvers<WorkspaceTopicDecideResponse["payload"]>();
      const response = {
        requestId: "approval-response",
        workspaceId: WORKSPACE_ID,
        topicKey,
        accepted: false,
        durableItem: approved,
        task: null,
        routedTo: "none",
        targetAgentId: null,
        entry: null,
        error: "The approval was saved, but the follow-up needs to be resumed.",
        errorCode: "topic_decision_resume_required",
      } satisfies WorkspaceTopicDecideResponse["payload"];
      const decideWorkspaceTopic = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({
          ...response,
          accepted: warning === null,
          errorCode: undefined,
          error: warning,
          task,
          entry: {
            entryId: "recorded-approval",
            workspaceId: WORKSPACE_ID,
            mainAgentId: MAIN_AGENT_ID,
            topicKey,
            taskId,
            rootMessageId: "m-1",
            role: "system_note",
            routedAgentId: MAIN_AGENT_ID,
            text: "Approval recorded",
            status: "completed",
            seq: 1,
            createdAt: updatedAt,
            updatedAt,
            origin: "decision_reply",
            durableItemRequestId: approval.requestId,
            decision: "approve",
          },
        } satisfies WorkspaceTopicDecideResponse["payload"]);
      const listWorkspaceDurableItems = vi.fn().mockResolvedValue({
        items: [approval],
        nextCursor: null,
        error: null,
      });
      vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
        connectionStatus: "online",
        client: { decideWorkspaceTopic, listWorkspaceDurableItems },
      } as never);
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      applyWorkspaceTasksUpdateToCache(qc, SERVER_ID, {
        workspaceId: WORKSPACE_ID,
        tasks: [task],
      });
      const onErrorToast = vi.fn();
      const list = (
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
        </QueryClientProvider>
      );
      const mounted = render(list);
      const approveId = `topic-decision-action-approve-${topicKey}`;
      const resumeId = `topic-decision-resume-${topicKey}`;
      const questionInputId = `topic-decision-input-${topicKey}`;
      fireEvent.change(await screen.findByTestId(`topic-decision-note-input-${topicKey}`), {
        target: { value: "Original conditions" },
      });
      fireEvent.click(screen.getByTestId(approveId));
      expect(decideWorkspaceTopic).toHaveBeenCalledExactlyOnceWith({
        workspaceId: WORKSPACE_ID,
        mainAgentId: MAIN_AGENT_ID,
        topicKey,
        taskId,
        rootMessageId: "m-1",
        clientMessageId: expect.any(String),
        resolutionKind: "durable_item",
        durableItemRequestId: approval.requestId,
        expectedRevision: 3,
        decision: "approve",
        note: "Original conditions",
      });
      const [originalRequest] = decideWorkspaceTopic.mock.calls[0]!;

      listWorkspaceDurableItems.mockResolvedValue({
        items: [approved],
        nextCursor: null,
        error: null,
      });
      await act(async () => {
        if (firstOutcome === "resume_required") first.resolve(response);
        else {
          applyDurableItemUpdateToCache(qc, SERVER_ID, {
            workspaceId: WORKSPACE_ID,
            item: approved,
          });
          first.reject(new Error("Connection closed before a response"));
        }
      });
      expect(screen.queryByTestId(approveId)).toBeNull();
      expect((screen.getByTestId(resumeId) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByTestId(`topic-decision-resume-feedback-${topicKey}`).textContent).toBe(
        firstOutcome === "resume_required"
          ? "topicWorkbench.topicStream.decisionResumeRequired"
          : "topicWorkbench.topicStream.decisionDeliveryUnconfirmed",
      );

      mounted.unmount();
      applyWorkspaceTasksUpdateToCache(qc, SERVER_ID, {
        workspaceId: WORKSPACE_ID,
        tasks: [newQuestion],
      });
      render(list);
      const questionInput = screen.getByTestId(questionInputId) as HTMLTextAreaElement;
      expect(questionInput.value).toBe("");
      fireEvent.change(questionInput, { target: { value: "Draft for the new question" } });
      fireEvent.click(screen.getByTestId(resumeId));

      await vi.waitFor(() => expect(screen.queryByTestId(resumeId)).toBeNull());
      expect(decideWorkspaceTopic.mock.calls).toEqual([[originalRequest], [originalRequest]]);
      expect(onErrorToast.mock.calls).toEqual(warning === null ? [] : [[warning]]);
      expect(screen.getByTestId(`topic-decision-question-${topicKey}`).textContent).toBe(
        newQuestion.blockingQuestion,
      );
      expect((screen.getByTestId(questionInputId) as HTMLTextAreaElement).value).toBe(
        "Draft for the new question",
      );
    },
  );

  it("handles stale_blocking_question end-to-end on desktop and compact paths without dropping draft", async () => {
    seedSession({
      supportsTopicThreads: true,
      supportsTopicReadState: true,
      supportsTaskLedger: true,
      supportsButlerV1: true,
    });
    const gen1 = "11111111-1111-4111-8111-111111111111";
    const gen2 = "22222222-2222-4222-8222-222222222222";
    const updatedTask = {
      taskId: "T-stale",
      title: "Stale question test",
      tier: "T2" as const,
      status: "awaiting_decision" as const,
      participants: [{ agentId: "lead-1" }],
      leadAgentId: "lead-1",
      blockingQuestion: "Updated question v2?",
      blockingQuestionGeneration: gen2,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:03:00.000Z",
    };
    const decideWorkspaceTopic = vi
      .fn()
      .mockResolvedValueOnce({
        requestId: "req-stale-1",
        workspaceId: WORKSPACE_ID,
        topicKey: "task:T-stale",
        durableItem: null,
        task: updatedTask,
        routedTo: "none",
        targetAgentId: null,
        entry: null,
        error: "The blocking question changed.",
        errorCode: "stale_blocking_question",
      })
      .mockResolvedValueOnce({
        requestId: "req-ok-2",
        workspaceId: WORKSPACE_ID,
        topicKey: "task:T-stale",
        durableItem: null,
        task: { ...updatedTask, status: "in_progress", blockingQuestion: undefined },
        routedTo: "lead",
        targetAgentId: "lead-1",
        entry: null,
        error: null,
      });
    vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
      connectionStatus: "online",
      client: { decideWorkspaceTopic },
    } as never);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    applyTopicAnchorToCache(qc, SERVER_ID, {
      workspaceId: WORKSPACE_ID,
      mainAgentId: MAIN_AGENT_ID,
      anchor: {
        workspaceId: WORKSPACE_ID,
        mainAgentId: MAIN_AGENT_ID,
        topicKey: "task:T-stale",
        taskId: "T-stale",
        rootPromptText: "Check blocking conflict",
        leadAgentId: "lead-1",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:01:00.000Z",
      },
    });
    applyWorkspaceTasksUpdateToCache(qc, SERVER_ID, {
      workspaceId: WORKSPACE_ID,
      tasks: [
        {
          ...updatedTask,
          blockingQuestion: "Original question v1?",
          blockingQuestionGeneration: gen1,
        },
      ],
    });

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

    const input = screen.getByTestId("topic-decision-input-task:T-stale");
    fireEvent.change(input, { target: { value: "My draft decision" } });
    fireEvent.click(screen.getByTestId("topic-decision-submit-task:T-stale"));

    // After stale_blocking_question: feedback shown, cache updated to v2 question, draft preserved!
    await vi.waitFor(() => {
      expect(screen.getByTestId("topic-decision-question-task:T-stale").textContent).toBe(
        "Updated question v2?",
      );
      expect(screen.getByTestId("topic-decision-feedback-task:T-stale").textContent).toBe(
        "topicWorkbench.topicStream.decisionBlockingQuestionStale",
      );
    });
    expect(decideWorkspaceTopic.mock.calls[0]![0]).toMatchObject({
      expectedBlockingQuestionGeneration: gen1,
      note: "My draft decision",
    });

    // Re-submit after inspecting updated question -> sends gen2!
    fireEvent.click(screen.getByTestId("topic-decision-submit-task:T-stale"));
    await vi.waitFor(() => {
      expect(decideWorkspaceTopic).toHaveBeenCalledTimes(2);
    });
    expect(decideWorkspaceTopic.mock.calls[1]![0]).toMatchObject({
      expectedBlockingQuestionGeneration: gen2,
      note: "My draft decision",
    });

    // Compact path: submitActiveTopicReply locks gen1 and throws TopicDecisionStaleQuestionError with latestTask.
    decideWorkspaceTopic.mockReset();
    decideWorkspaceTopic.mockResolvedValueOnce({
      requestId: "req-compact-stale",
      workspaceId: WORKSPACE_ID,
      topicKey: "task:T-stale",
      durableItem: null,
      task: updatedTask,
      routedTo: "none",
      targetAgentId: null,
      entry: null,
      error: "The blocking question changed.",
      errorCode: "stale_blocking_question",
    });
    await expect(
      submitActiveTopicReply({
        queryClient: qc,
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        agentId: MAIN_AGENT_ID,
        activeReplyTopic: {
          topicKey: "task:T-stale",
          taskId: "T-stale",
          promptPreview: "Check blocking conflict",
          routeMode: "auto",
          decisionContext: {
            kind: "task_blocking_question",
            taskId: "T-stale",
            question: "Original question v1?",
            blockingQuestionGeneration: gen1,
          },
        },
        payload: { text: "Compact draft", attachments: [], cwd: "/repo" },
        supportsTopicThreads: true,
        supportsButlerV1: true,
        supportsForgeAttachments: true,
        disconnectedMessage: "Host disconnected",
      }),
    ).rejects.toBeInstanceOf(TopicDecisionStaleQuestionError);
    expect(decideWorkspaceTopic).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedBlockingQuestionGeneration: gen1,
        note: "Compact draft",
      }),
    );
  });

  it("keeps sibling tasks under one rootMessageId distinct in scroll matching and routes legacy unbound DurableItem to standalone approval view", () => {
    seedSession({
      supportsTopicThreads: true,
      supportsTopicReadState: true,
      supportsTaskLedger: true,
      supportsButlerV1: true,
    });
    const decideWorkspaceTopic = vi.fn();
    vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
      connectionStatus: "online",
      client: { decideWorkspaceTopic },
    } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<WorkspaceDurableItem[]>(durableItemsQueryKey(SERVER_ID, WORKSPACE_ID), [
      {
        workspaceId: WORKSPACE_ID,
        requestId: "dur-legacy-unbound",
        sourceAgentId: "lead-1",
        sourceTurnId: "turn-legacy",
        kind: "acceptance",
        title: "Legacy unbound acceptance",
        evidence: [],
        createdAt: "2026-06-01T00:01:00.000Z",
        revision: 1,
        status: "pending",
      },
    ]);
    applyTopicAnchorToCache(qc, SERVER_ID, {
      workspaceId: WORKSPACE_ID,
      mainAgentId: MAIN_AGENT_ID,
      anchor: {
        workspaceId: WORKSPACE_ID,
        mainAgentId: MAIN_AGENT_ID,
        topicKey: "task:T-A",
        taskId: "T-A",
        rootMessageId: "m-multi",
        rootPromptText: "Shared root question",
        leadAgentId: "lead-1",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:01.000Z",
      },
    });
    applyTopicAnchorToCache(qc, SERVER_ID, {
      workspaceId: WORKSPACE_ID,
      mainAgentId: MAIN_AGENT_ID,
      anchor: {
        workspaceId: WORKSPACE_ID,
        mainAgentId: MAIN_AGENT_ID,
        topicKey: "task:T-B",
        taskId: "T-B",
        rootMessageId: "m-multi",
        rootPromptText: "Shared root question",
        leadAgentId: "lead-2",
        createdAt: "2026-06-01T00:00:02.000Z",
        updatedAt: "2026-06-01T00:00:02.000Z",
      },
    });
    applyWorkspaceTasksUpdateToCache(qc, SERVER_ID, {
      workspaceId: WORKSPACE_ID,
      tasks: [
        {
          taskId: "T-A",
          title: "Task A",
          tier: "T2",
          status: "in_progress",
          participants: [{ agentId: "lead-1" }],
          rootMessageId: "m-multi",
          leadAgentId: "lead-1",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:01.000Z",
        },
        {
          taskId: "T-B",
          title: "Task B",
          tier: "T2",
          status: "in_progress",
          participants: [{ agentId: "lead-2" }],
          rootMessageId: "m-multi",
          leadAgentId: "lead-2",
          createdAt: "2026-06-01T00:00:02.000Z",
          updatedAt: "2026-06-01T00:00:02.000Z",
        },
      ],
    });

    const toggleDirectory = vi.fn();

    render(
      <QueryClientProvider client={qc}>
        <PaneProvider value={makePaneContextValue()}>
          <TeamDirectoryShellProvider value={makeTeamDirectoryShellValue(toggleDirectory)}>
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
          </TeamDirectoryShellProvider>
        </PaneProvider>
      </QueryClientProvider>,
    );

    // Both sibling task cards render simultaneously.
    expect(screen.getByTestId("topic-thread-card-task:T-A")).toBeTruthy();
    expect(screen.getByTestId("topic-thread-card-task:T-B")).toBeTruthy();

    // Legacy unbound DurableItem on task:T-A does NOT render in-card topic decide buttons;
    // clicking its redirect button opens the Team Directory on the "todos" approval tab.
    expect(screen.queryByTestId("topic-decision-action-approve-task:T-A")).toBeNull();
    fireEvent.click(screen.getByTestId("topic-decision-open-standalone-task:T-A"));
    expect(useTeamDirectoryViewStore.getState().activeTab).toBe("todos");
    expect(toggleDirectory).toHaveBeenCalledTimes(1);
    expect(decideWorkspaceTopic).not.toHaveBeenCalled();

    // Scroll matching with explicit taskId never collides with sibling sharing rootMessageId.
    expect(
      topicMatchesScrollTarget(
        {
          topicKey: "task:T-A",
          taskId: "T-A",
          rootItemId: "u-multi:T-A",
          rootMessageId: "m-multi",
          rootPrompt: {
            id: "u-multi",
            messageId: "m-multi",
            text: "Shared root question",
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
          fileConflicts: [],
          activeBlockingPrompt: null,
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
        { topicKey: "task:T-B", taskId: "T-B", rootMessageId: "m-multi" },
      ),
    ).toBe(false);
  });

  it("guards compact async decision refreshes against switched targets and never downgrades missing next generation to versionless", () => {
    const agentKey = buildTopicAgentKey(SERVER_ID, MAIN_AGENT_ID);
    const genA1 = "11111111-1111-4111-8111-111111111111";
    const genA2 = "22222222-2222-4222-8222-222222222222";
    const genB1 = "33333333-3333-4333-8333-333333333333";

    const store = useTopicStreamViewStore.getState();
    // User enters compact decision reply for T-A (genA1), then switches to T-B (genB1) while T-A is in flight.
    store.setActiveReplyTopic(agentKey, {
      topicKey: "task:T-B",
      taskId: "T-B",
      promptPreview: "Task B",
      routeMode: "auto",
      pendingClientMessageId: "cm-b",
      pendingSubmissionSignature: "sig-b",
      decisionContext: {
        kind: "task_blocking_question",
        taskId: "T-B",
        question: "Task B question?",
        blockingQuestionGeneration: genB1,
      },
    });

    // Late stale response for T-A must NOT mutate or clear T-B.
    store.refreshActiveDecisionContext(agentKey, {
      expectedTarget: {
        topicKey: "task:T-A",
        taskId: "T-A",
        decisionKind: "task_blocking_question",
        decisionTaskId: "T-A",
        blockingQuestionGeneration: genA1,
      },
      question: "Task A new question?",
      blockingQuestionGeneration: genA2,
      staleNotice: "Stale notice A",
    });
    store.clearActiveReplyTopicIfMatches(agentKey, {
      topicKey: "task:T-A",
      taskId: "T-A",
      decisionKind: "task_blocking_question",
      decisionTaskId: "T-A",
      blockingQuestionGeneration: genA1,
    });
    expect(useTopicStreamViewStore.getState().activeReplyTopicByAgentKey[agentKey]).toMatchObject({
      topicKey: "task:T-B",
      pendingClientMessageId: "cm-b",
      decisionContext: {
        question: "Task B question?",
        blockingQuestionGeneration: genB1,
      },
    });
    expect(
      useTopicStreamViewStore.getState().activeReplyTopicByAgentKey[agentKey]?.decisionContext
        ?.staleNotice,
    ).toBeUndefined();

    // Now stay on T-A (genA1) and receive a stale response with NO next generation (e.g. already resolved):
    // must keep genA1 locked & preserve submission intent (never downgrade to undefined/versionless).
    store.setActiveReplyTopic(agentKey, {
      topicKey: "task:T-A",
      taskId: "T-A",
      promptPreview: "Task A",
      routeMode: "auto",
      pendingClientMessageId: "cm-a1",
      pendingSubmissionSignature: "sig-a1",
      decisionContext: {
        kind: "task_blocking_question",
        taskId: "T-A",
        question: "Task A v1?",
        blockingQuestionGeneration: genA1,
      },
    });
    store.refreshActiveDecisionContext(agentKey, {
      expectedTarget: {
        topicKey: "task:T-A",
        taskId: "T-A",
        decisionKind: "task_blocking_question",
        decisionTaskId: "T-A",
        blockingQuestionGeneration: genA1,
      },
      question: undefined,
      blockingQuestionGeneration: undefined,
      staleNotice: "Stale resolved notice",
    });
    expect(useTopicStreamViewStore.getState().activeReplyTopicByAgentKey[agentKey]).toMatchObject({
      topicKey: "task:T-A",
      pendingClientMessageId: "cm-a1",
      pendingSubmissionSignature: "sig-a1",
      decisionContext: {
        question: "Task A v1?",
        blockingQuestionGeneration: genA1,
        staleNotice: "Stale resolved notice",
      },
    });

    // When a valid new generation (genA2) arrives for the matching target, refresh generation & clear idempotency key.
    store.refreshActiveDecisionContext(agentKey, {
      expectedTarget: {
        topicKey: "task:T-A",
        taskId: "T-A",
        decisionKind: "task_blocking_question",
        decisionTaskId: "T-A",
        blockingQuestionGeneration: genA1,
      },
      question: "Task A v2?",
      blockingQuestionGeneration: genA2,
      staleNotice: "Stale updated notice",
    });
    expect(useTopicStreamViewStore.getState().activeReplyTopicByAgentKey[agentKey]).toMatchObject({
      topicKey: "task:T-A",
      pendingClientMessageId: undefined,
      pendingSubmissionSignature: undefined,
      decisionContext: {
        question: "Task A v2?",
        blockingQuestionGeneration: genA2,
        staleNotice: "Stale updated notice",
      },
    });
  });

  it("opens a reachable standalone approval sheet/panel in compact mode for a Main Control sourced unbound DurableItem", () => {
    mockIsCompactFormFactor = true;
    seedSession({
      supportsTopicThreads: true,
      supportsTopicReadState: true,
      supportsTaskLedger: true,
      supportsButlerV1: true,
    });
    const decideWorkspaceTopic = vi.fn();
    vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
      connectionStatus: "online",
      client: { decideWorkspaceTopic },
    } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<WorkspaceDurableItem[]>(durableItemsQueryKey(SERVER_ID, WORKSPACE_ID), [
      {
        workspaceId: WORKSPACE_ID,
        requestId: "dur-main-unbound",
        sourceAgentId: MAIN_AGENT_ID,
        sourceTurnId: "turn-main-1",
        kind: "decision",
        title: "Main control unbound decision",
        evidence: [],
        createdAt: "2026-06-01T00:01:00.000Z",
        revision: 1,
        status: "pending",
      },
    ]);
    applyWorkspaceTasksUpdateToCache(qc, SERVER_ID, {
      workspaceId: WORKSPACE_ID,
      tasks: [
        {
          taskId: "T-main",
          title: "Main task",
          tier: "T1",
          status: "in_progress",
          participants: [{ agentId: MAIN_AGENT_ID }],
          rootMessageId: "m-1",
          leadAgentId: MAIN_AGENT_ID,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:01.000Z",
        },
      ],
    });

    // 1) Compact shell with WorkspaceSheetStack opener (real WorkspaceScreen compact path):
    // clicking opens the "team" sheet page on the stack and selects the "todos" approval tab.
    const sheetStack = createWorkspaceSheetStack();
    const openCompactSheet = vi.fn(() => {
      sheetStack.push({
        key: "team",
        title: "Team",
        render: () => null,
      });
    });
    const toggleDirectory = vi.fn();
    const firstRender = render(
      <QueryClientProvider client={qc}>
        <PaneProvider value={makePaneContextValue()}>
          <TeamDirectoryShellProvider
            value={makeTeamDirectoryShellValue(toggleDirectory, {
              isOwnedByWorkspaceShell: false,
              isDirectoryVisible: false,
              openDirectory: openCompactSheet,
            })}
          >
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
          </TeamDirectoryShellProvider>
        </PaneProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("topic-decision-open-standalone-task:T-main"));
    expect(useTeamDirectoryViewStore.getState().activeTab).toBe("todos");
    expect(openCompactSheet).toHaveBeenCalledTimes(1);
    expect(sheetStack.getSnapshot().map((entry) => entry.key)).toEqual(["page:team"]);
    expect(decideWorkspaceTopic).not.toHaveBeenCalled();

    // 2) Compact host without openDirectory falls back to toggleDirectory when source === main.
    firstRender.unmount();
    useTeamDirectoryViewStore.setState({ activeTab: "agents" });
    render(
      <QueryClientProvider client={qc}>
        <PaneProvider value={makePaneContextValue()}>
          <TeamDirectoryShellProvider
            value={makeTeamDirectoryShellValue(toggleDirectory, {
              isOwnedByWorkspaceShell: false,
              isDirectoryVisible: false,
            })}
          >
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
          </TeamDirectoryShellProvider>
        </PaneProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("topic-decision-open-standalone-task:T-main"));
    expect(useTeamDirectoryViewStore.getState().activeTab).toBe("todos");
    expect(toggleDirectory).toHaveBeenCalledTimes(1);
    expect(decideWorkspaceTopic).not.toHaveBeenCalled();
  });
});
