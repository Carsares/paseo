/** @vitest-environment jsdom */
import {
  PARENT_AGENT_ID_LABEL,
  RESIDENT_AGENT_LABEL,
  RESIDENT_ROLE_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { MainControlTreeLayout } from "./main-control-tree";

const runtime = vi.hoisted(() => ({
  archived: [] as ReturnType<typeof agent>[],
  openPreferred: vi.fn(),
  navigateToAgent: vi.fn(),
  loadMore: vi.fn(),
  lastEnabled: false,
}));
vi.mock("lucide-react-native", async (original) => {
  const icons = await original<typeof import("lucide-react-native")>();
  return { ...icons, PanelLeftClose: icons.PanelLeft };
});
vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));
vi.mock("@/panels/pane-context", async (original) => ({
  ...(await original<typeof import("@/panels/pane-context")>()),
  usePaneContext: () => ({ serverId: "host", workspaceId: "workspace", tabId: "main-tab" }),
  usePaneFocus: () => ({ focusPane: vi.fn() }),
}));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: runtime.navigateToAgent }));
vi.mock("@/workspace-tabs/open-beside", () => ({
  openPreferredWorkspaceTarget: runtime.openPreferred,
}));
vi.mock("./use-workspace-archived-agents", () => ({
  useWorkspaceArchivedAgents: ({ enabled }: { enabled?: boolean }) => {
    runtime.lastEnabled = Boolean(enabled);
    return {
      data: enabled ? runtime.archived : [],
      hasLoadedOnce: Boolean(enabled),
      hasMore: false,
      supportsWorkspaceHistory: true,
      isLoading: false,
      isLoadingMore: false,
      isError: false,
      loadMore: runtime.loadMore,
      refetch: vi.fn(),
    };
  },
}));

function agent(id: string, title: string, labels: Record<string, string>, archivedAt?: Date) {
  const timestamp = new Date(0).toISOString();
  return normalizeAgentSnapshot(
    {
      id,
      title,
      labels,
      archivedAt: archivedAt?.toISOString(),
      workspaceId: "workspace",
      status: "idle",
      provider: "codex",
      cwd: "/repo",
      model: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUserMessageAt: null,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      availableModes: [],
      pendingPermissions: [],
      currentModeId: null,
      persistence: null,
    },
    "host",
  );
}

afterEach(() => {
  cleanup();
  runtime.archived = [];
  runtime.lastEnabled = false;
  vi.clearAllMocks();
});

const toast = { show: () => () => {}, copied: vi.fn(), error: vi.fn() };

it("hides and restores the directory without duplicate expand-all controls and opens history on demand", () => {
  const main = agent("main", "Coordinator", { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE });
  const closed = agent("closed", "Layout closed", { [PARENT_AGENT_ID_LABEL]: "main" });
  const resident = agent("resident", "Review notes", {
    [PARENT_AGENT_ID_LABEL]: "main",
    [RESIDENT_AGENT_LABEL]: "true",
    [RESIDENT_ROLE_LABEL]: "Reviewer",
  });
  useSessionStore.getState().initializeSession("host", null as unknown as DaemonClient);
  useSessionStore.getState().setAgents(
    "host",
    new Map([
      [main.id, main],
      [closed.id, closed],
      [resident.id, resident],
    ]),
  );
  useWorkspaceLayoutStore.getState().setLayoutMode("split-panes");
  runtime.archived = [agent("archive", "Archived conversation", {}, new Date(1))];

  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastApiProvider api={toast}>
        <MainControlTreeLayout mainAgentId="main">Conversation</MainControlTreeLayout>
      </ToastApiProvider>
    </QueryClientProvider>,
  );

  // History is not fetched until expanded, and duplicate header expand-all button is gone.
  expect(runtime.lastEnabled).toBe(false);
  expect(screen.queryByTestId("main-control-tree-toggle-all")).toBeNull();
  expect(screen.getByTestId("main-control-tree-row-resident")).toBeTruthy();
  expect(screen.queryByTestId("main-control-tree-row-closed")).toBeNull();

  // Hide and show again.
  fireEvent.click(screen.getByTestId("main-control-tree-hide"));
  expect(screen.queryByTestId("main-control-tree")).toBeNull();
  fireEvent.click(screen.getByTestId("main-control-tree-show"));
  expect(screen.getByTestId("main-control-tree")).toBeTruthy();

  // Click to view history members on demand.
  fireEvent.click(screen.getByTestId("main-control-tree-toggle-closed"));
  expect(runtime.lastEnabled).toBe(true);
  fireEvent.click(screen.getByTestId("main-control-tree-row-closed"));
  expect(runtime.openPreferred).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      workspaceKey: "host:workspace",
      target: { kind: "agent", agentId: "closed" },
      parentTabId: "main-tab",
    }),
  );
  fireEvent.click(screen.getByTestId("main-control-tree-row-archive"));
  expect(runtime.navigateToAgent).toHaveBeenCalledExactlyOnceWith({
    serverId: "host",
    workspaceId: "workspace",
    agentId: "archive",
    pin: true,
    asTab: true,
  });
});
