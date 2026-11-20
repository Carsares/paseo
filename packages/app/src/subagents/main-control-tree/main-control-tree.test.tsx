/** @vitest-environment jsdom */
import {
  PARENT_AGENT_ID_LABEL,
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
  useWorkspaceArchivedAgents: () => ({
    data: runtime.archived,
    supportsWorkspaceHistory: true,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
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
  vi.clearAllMocks();
});

const toast = { show: () => () => {}, copied: vi.fn(), error: vi.fn() };

it("expands the hidden directory and opens both kinds of Closed session directly", () => {
  const main = agent("main", "Coordinator", { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE });
  const closed = agent("closed", "Layout closed", { [PARENT_AGENT_ID_LABEL]: "main" });
  useSessionStore.getState().initializeSession("host", null as unknown as DaemonClient);
  useSessionStore.getState().setAgents(
    "host",
    new Map([
      [main.id, main],
      [closed.id, closed],
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
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(screen.queryByRole("button", { name: /Archived conversation/ })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Expand all sessions, Closed (2)" }));
  expect(screen.getAllByRole("button", { name: "Closed (2)" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Coordinator, Main, Idle" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Layout closed, Closed" }));
  expect(runtime.openPreferred).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      workspaceKey: "host:workspace",
      target: { kind: "agent", agentId: "closed" },
      parentTabId: "main-tab",
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Archived conversation, Standalone, Closed" }),
  );
  expect(runtime.navigateToAgent).toHaveBeenCalledExactlyOnceWith({
    serverId: "host",
    workspaceId: "workspace",
    agentId: "archive",
    pin: true,
    asTab: true,
  });
});
