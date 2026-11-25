/** @vitest-environment jsdom */
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  PARENT_AGENT_ID_LABEL,
  RESIDENT_AGENT_LABEL,
  RESIDENT_ROLE_LABEL,
  SIDE_CHAT_LABEL,
  SIDE_OF_AGENT_ID_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useTeamDirectoryViewStore } from "@/stores/team-directory-view-store";
import { useTopicInboxReadStore } from "@/stores/topic-inbox-read-store";
import type { StreamItem } from "@/types/stream";
import { createTeamMessageJumpStore, TeamMessageJumpProvider } from "./message-jump-store";
import { WorkspaceTeamDirectory } from "./team-directory";

const runtime = vi.hoisted(() => ({
  client: null as unknown as {
    archiveAgent: ReturnType<typeof vi.fn>;
    flushAgentInbox: ReturnType<typeof vi.fn>;
    clearWorkspaceAttention: ReturnType<typeof vi.fn>;
    getLastServerInfoMessage: () => { permissions: string[] };
  },
  archiveAgentSnapshot: vi.fn(),
}));

vi.mock("lucide-react-native", async (original) => {
  const icons = await original<typeof import("lucide-react-native")>();
  const Icon = () => null;
  return {
    ...icons,
    Archive: icons.Archive ?? Icon,
    Check: icons.Check ?? Icon,
    CheckCheck: icons.CheckCheck ?? Icon,
    ChevronDown: icons.ChevronDown ?? Icon,
    ChevronRight: icons.ChevronRight ?? Icon,
    Columns2: icons.Columns2 ?? Icon,
    ExternalLink: icons.ExternalLink ?? Icon,
    MoreVertical: icons.MoreVertical ?? Icon,
    PanelLeftClose: icons.PanelLeftClose ?? Icon,
    Plus: icons.Plus ?? Icon,
    RotateCcw: icons.RotateCcw ?? Icon,
    Send: icons.Send ?? Icon,
    Trash2: icons.Trash2 ?? Icon,
    Unlink: icons.Unlink ?? Icon,
    UserMinus: icons.UserMinus ?? Icon,
    UserPlus: icons.UserPlus ?? Icon,
  };
});
vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));
vi.mock("@/durable-items/card", () => ({
  DurableItemCard: () => null,
}));
vi.mock("@/durable-items/queries", () => ({
  useWorkspaceDurableItems: () => ({
    result: { data: [] },
    online: true,
  }),
}));
vi.mock("@/runtime/host-runtime", async (original) => ({
  ...(await original<typeof import("@/runtime/host-runtime")>()),
  getHostRuntimeStore: () => ({ archiveAgentSnapshot: runtime.archiveAgentSnapshot }),
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("../resident-dialog", () => ({
  useOpenResidentDialog: () => null,
  useCreateResidentAction: () => undefined,
}));
vi.mock("../use-archive-subagent", () => ({
  useArchiveSubagent: () => vi.fn(),
}));
vi.mock("../use-detach-subagent", () => ({
  useDetachSubagent: () => vi.fn(),
}));
vi.mock("../main-control-tree/use-workspace-archived-agents", () => ({
  useWorkspaceArchivedAgents: () => ({
    data: [],
    hasLoadedOnce: false,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    isError: false,
    loadMore: vi.fn(),
    refetch: vi.fn(),
    supportsWorkspaceHistory: true,
  }),
}));

const SERVER_ID = "srv-cleanup";
const WORKSPACE_ID = "ws-topic";

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    serverId: SERVER_ID,
    provider: "codex",
    cwd: "/ws",
    model: null,
    createdAt: new Date(0),
    updatedAt: new Date(1),
    lastActivityAt: new Date(1),
    lastUserMessageAt: new Date(1),
    currentModeId: null,
    availableModes: [],
    persistence: null,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    title: id,
    workspaceId: WORKSPACE_ID,
    parentAgentId: null,
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    pendingPermissions: [],
    labels: {},
    ...overrides,
  };
}

function setupDirectory({
  supportsIdleArchive,
  extraAgents = [],
  mainStreamTail = [],
}: {
  supportsIdleArchive: boolean;
  extraAgents?: Agent[];
  mainStreamTail?: StreamItem[];
}) {
  const archiveAgent = vi.fn(async () => ({ archivedAt: "2026-11-24T12:00:00.000Z" }));
  const flushAgentInbox = vi.fn(async () => ({}));
  const clearWorkspaceAttention = vi.fn(async () => ({}));
  const onOpenAgent = vi.fn();
  const jumpStore = createTeamMessageJumpStore();

  runtime.archiveAgentSnapshot.mockImplementation(
    (serverId: string, agentId: string, archivedAt: string) => {
      useSessionStore.getState().setAgents(serverId, (agents) => {
        const current = agents.get(agentId);
        if (!current) return agents;
        const next = new Map(agents);
        next.set(agentId, { ...current, archivedAt: new Date(archivedAt) });
        return next;
      });
    },
  );
  const serverInfoMessage = { permissions: ["workspace.write", "hub.execute"] };
  runtime.client = {
    archiveAgent,
    flushAgentInbox,
    clearWorkspaceAttention,
    getLastServerInfoMessage: () => serverInfoMessage,
  };
  const store = useSessionStore.getState();
  store.initializeSession(SERVER_ID, runtime.client as unknown as DaemonClient);
  store.setAgents(
    SERVER_ID,
    new Map([
      ["main-1", makeAgent("main-1", { labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE } })],
      [
        "resident-1",
        makeAgent("resident-1", {
          labels: {
            [PARENT_AGENT_ID_LABEL]: "main-1",
            [RESIDENT_AGENT_LABEL]: "true",
            [RESIDENT_ROLE_LABEL]: "Reviewer",
          },
        }),
      ],
      [
        "task-idle",
        makeAgent("task-idle", {
          labels: { [PARENT_AGENT_ID_LABEL]: "main-1" },
          status: "idle",
          requiresAttention: false,
        }),
      ],
      ...extraAgents.map((agent) => [agent.id, agent] as const),
    ]),
  );
  if (mainStreamTail.length > 0) {
    store.setAgentStreamState(SERVER_ID, "main-1", { tail: mainStreamTail });
  }
  store.updateSessionServerInfo(SERVER_ID, {
    serverId: SERVER_ID,
    hostname: null,
    version: null,
    features: { agentIdleArchiveV1: supportsIdleArchive },
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TeamMessageJumpProvider store={jumpStore}>
        <WorkspaceTeamDirectory
          serverId={SERVER_ID}
          workspaceId={WORKSPACE_ID}
          mainAgentId="main-1"
          isTopicWorkspace
          focusedAgentId="main-1"
          focusedProviderSubagentId={null}
          onHide={vi.fn()}
          onOpenAgent={onOpenAgent}
          onOpenAgentBeside={vi.fn()}
          onOpenProviderSubrun={vi.fn()}
        />
      </TeamMessageJumpProvider>
    </QueryClientProvider>,
  );
  return { archiveAgent, onOpenAgent, jumpStore };
}

beforeEach(() => {
  useTeamDirectoryViewStore.setState({ activeTab: "agents", agentGroupMode: "activity" });
  useTopicInboxReadStore.setState({ scopes: {} });
});

afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession(SERVER_ID);
  vi.clearAllMocks();
});

it("collapses non-focused idle members by default in activity mode and hides batch cleanup when agentIdleArchiveV1 is unsupported", () => {
  const { archiveAgent } = setupDirectory({ supportsIdleArchive: false });

  // Focused main-1 stays visible while task-idle and resident-1 are folded under inactive
  expect(screen.getByTestId("team-directory-row-main-1")).toBeTruthy();
  expect(screen.queryByTestId("team-directory-row-task-idle")).toBeNull();
  expect(screen.queryByTestId("team-directory-cleanup-finished")).toBeNull();

  fireEvent.click(screen.getByTestId("team-directory-toggle-inactive"));
  expect(screen.getByTestId("team-directory-row-task-idle")).toBeTruthy();
  expect(screen.getByTestId("team-directory-row-resident-1")).toBeTruthy();
  expect(archiveAgent).not.toHaveBeenCalled();
});

it("archives cleanable idle subagents via client.archiveAgent(..., { onlyIfIdle: true }) directly from the inactive header", async () => {
  const { archiveAgent } = setupDirectory({ supportsIdleArchive: true });

  fireEvent.click(screen.getByTestId("team-directory-toggle-inactive"));
  expect(screen.getByTestId("team-directory-row-task-idle")).toBeTruthy();

  fireEvent.click(screen.getByTestId("team-directory-cleanup-finished"));

  await waitFor(() =>
    expect(archiveAgent).toHaveBeenCalledExactlyOnceWith("task-idle", WORKSPACE_ID, {
      onlyIfIdle: true,
    }),
  );
  await waitFor(() => expect(screen.queryByTestId("team-directory-row-task-idle")).toBeNull());
  expect(screen.getByTestId("team-directory-row-main-1")).toBeTruthy();
  expect(screen.getByTestId("team-directory-row-resident-1")).toBeTruthy();
});

it("surfaces retry state when the host rejects an idle-only archive without falling back to normal archive", async () => {
  const { archiveAgent } = setupDirectory({ supportsIdleArchive: true });
  archiveAgent.mockRejectedValueOnce(new Error("agent has an active turn"));

  fireEvent.click(screen.getByTestId("team-directory-cleanup-finished"));

  await waitFor(() =>
    expect(archiveAgent).toHaveBeenCalledExactlyOnceWith("task-idle", WORKSPACE_ID, {
      onlyIfIdle: true,
    }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("team-directory-cleanup-finished").getAttribute("aria-label")).toBe(
      "topicWorkbench.directory.cleanupRetry",
    ),
  );
});

it("switches between attribute view (showing parent Level-1 on Level-2 rows) and messages tab (click-to-jump + mark read)", () => {
  const runningL2 = makeAgent("l2-worker", {
    title: "Verifier L2",
    labels: { [PARENT_AGENT_ID_LABEL]: "task-idle" },
    status: "running",
  });
  const sideChat = makeAgent("side-1", {
    title: "Scratchpad",
    labels: { [SIDE_CHAT_LABEL]: "true", [SIDE_OF_AGENT_ID_LABEL]: "main-1" },
  });
  const reportItem = {
    kind: "tool_call",
    id: "msg-row-1",
    timestamp: new Date("2026-11-25T09:00:00.000Z"),
    timelineCursor: { epoch: "ep-1", seq: 42 },
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: "msg-row-1",
        name: "agent_message",
        status: "completed",
        detail: { type: "unknown", input: null, output: null },
        agentMessage: {
          event: "message",
          reportStatus: "completed",
          sender: { id: "task-idle", title: "task-idle" },
          text: "Verification complete with 0 errors",
        },
      },
    },
  } as unknown as StreamItem;

  const { onOpenAgent, jumpStore } = setupDirectory({
    supportsIdleArchive: true,
    extraAgents: [runningL2, sideChat],
    mainStreamTail: [reportItem],
  });

  fireEvent.click(screen.getByTestId("team-directory-group-attribute"));
  expect(screen.getByTestId("team-directory-attribute-main")).toBeTruthy();
  expect(screen.getByTestId("team-directory-row-side-1")).toBeTruthy();
  expect(screen.getByTestId("team-directory-attribute-l2")).toBeTruthy();
  expect(screen.getByTestId("team-directory-parent-l2-worker")).toBeTruthy();

  fireEvent.click(screen.getByTestId("team-directory-tab-messages"));
  expect(screen.getByTestId("team-directory-unread-section")).toBeTruthy();
  fireEvent.click(screen.getByTestId("team-directory-message-msg:msg-row-1"));

  expect(onOpenAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: "main-1" }));
  expect(jumpStore.getIntent()).toMatchObject({
    serverId: SERVER_ID,
    agentId: "main-1",
    itemId: "msg-row-1",
    epoch: "ep-1",
    seq: 42,
  });
  expect(screen.getByTestId("team-directory-read-section")).toBeTruthy();
});
