import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/dom";
import type { HostAppearanceSource, HostBadgeModel } from "@/hosts/appearance";
import { i18n as testI18n } from "@/i18n/i18next";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { SidebarUnreadConclusionsSection } from "./sidebar-unread-conclusions-section";

const navigateToAgent = vi.hoisted(() => vi.fn());
const clients = vi.hoisted(
  () => new Map<string, { clearAgentAttention: ReturnType<typeof vi.fn> }>(),
);
const mockHosts = vi.hoisted(() => ({ current: [] as HostAppearanceSource[] }));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent,
  openForkSourceAgent: vi.fn(),
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({
  useLocalDaemonServerId: () => null,
  useLocalDaemonServerIdState: () => ({ status: "resolved", serverId: null }),
}));

vi.mock("@/runtime/host-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/host-runtime")>()),
  useHosts: () => mockHosts.current,
  getHostRuntimeStore: () => ({
    getSnapshot: (serverId: string) => {
      const client = clients.get(serverId);
      return client ? { client } : null;
    },
  }),
}));

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(async () => {
  await testI18n.changeLanguage("en");
  navigateToAgent.mockReset();
  clients.clear();
  mockHosts.current = [];
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  useSidebarCollapsedSectionsStore.setState({ collapsedUnreadConclusions: false });
  container = document.createElement("div");
  container.style.width = "280px";
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  useSessionStore.setState({ sessions: {} });
});

function finishedAgent(id: string, minute: number): Agent {
  return {
    id,
    status: "idle",
    title: `Conversation ${id}`,
    workspaceId: "ws-1",
    parentAgentId: null,
    archivedAt: null,
    background: false,
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: new Date(Date.UTC(2026, 0, 1, 0, minute)),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0)),
  } as unknown as Agent;
}

function seed(agentsByServer: Record<string, Agent[]>) {
  const workspace = {
    id: "ws-1",
    name: "main",
    title: null,
    projectDisplayName: "Paseo",
    projectCustomName: null,
    archivingAt: null,
  } as unknown as WorkspaceDescriptor;
  const sessions = Object.fromEntries(
    Object.entries(agentsByServer).map(([serverId, agents]) => [
      serverId,
      {
        agents: new Map(agents.map((agent) => [agent.id, agent])),
        workspaces: new Map([["ws-1", workspace]]),
      },
    ]),
  );
  act(() => useSessionStore.setState({ sessions: sessions as never }));
}

function renderSection(
  onWorkspacePress?: () => void,
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel> = new Map(),
) {
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <SidebarUnreadConclusionsSection
          hostBadgeByServerId={hostBadgeByServerId}
          onWorkspacePress={onWorkspacePress}
        />
      </QueryClientProvider>,
    ),
  );
}

function view() {
  return within(container);
}

function rows(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid^="sidebar-unread-conclusion-row-"]'),
  );
}

function click(element: HTMLElement) {
  act(() => element.click());
}

describe("SidebarUnreadConclusionsSection", () => {
  it("renders nothing when no conversation is waiting to be read", () => {
    seed({ "host-a": [{ ...finishedAgent("quiet", 1), requiresAttention: false } as Agent] });
    renderSection();

    expect(container.firstChild).toBeNull();
    expect(view().queryByTestId("sidebar-unread-conclusions-section")).toBeNull();
  });

  it("shows five rows, newest first, and reveals the rest on demand", () => {
    seed({
      "host-a": Array.from({ length: 7 }, (_, index) => finishedAgent(`a${index + 1}`, index + 1)),
    });
    renderSection();

    expect(view().getByText("Unread conclusions")).toBeTruthy();
    expect(rows().map((row) => row.dataset.testid)).toEqual(
      ["a7", "a6", "a5", "a4", "a3"].map((id) => `sidebar-unread-conclusion-row-host-a-${id}`),
    );

    click(view().getByTestId("sidebar-unread-conclusions-show-more"));
    expect(rows()).toHaveLength(7);

    click(view().getByTestId("sidebar-unread-conclusions-show-more"));
    expect(rows()).toHaveLength(5);
  });

  it("collapses to the header from the section title", () => {
    seed({ "host-a": [finishedAgent("a1", 1)] });
    renderSection();
    expect(rows()).toHaveLength(1);

    click(view().getByTestId("sidebar-unread-conclusions-header"));

    expect(rows()).toHaveLength(0);
    expect(view().getByTestId("sidebar-unread-conclusions-header")).toBeTruthy();
  });

  it("closes the panel, then opens the conversation as a tab, when a row is pressed", () => {
    seed({ "host-a": [finishedAgent("a1", 1)] });
    const onWorkspacePress = vi.fn();
    renderSection(onWorkspacePress);

    click(view().getByTestId("sidebar-unread-conclusion-press-host-a-a1"));

    expect(onWorkspacePress).toHaveBeenCalledTimes(1);
    expect(navigateToAgent).toHaveBeenCalledWith({
      serverId: "host-a",
      agentId: "a1",
      workspaceId: "ws-1",
      asTab: true,
    });
    expect(onWorkspacePress.mock.invocationCallOrder[0]).toBeLessThan(
      navigateToAgent.mock.invocationCallOrder[0],
    );
  });

  it("marks a single conversation read without opening it", async () => {
    const clearA = vi.fn().mockResolvedValue(undefined);
    clients.set("host-a", { clearAgentAttention: clearA });
    seed({ "host-a": [finishedAgent("a1", 1), finishedAgent("a2", 2)] });
    const onWorkspacePress = vi.fn();
    renderSection(onWorkspacePress);

    await act(async () => {
      view().getByTestId("sidebar-unread-conclusion-mark-read-host-a-a1").click();
    });

    expect(clearA).toHaveBeenCalledTimes(1);
    expect(clearA).toHaveBeenCalledWith("a1");
    expect(navigateToAgent).not.toHaveBeenCalled();
    expect(onWorkspacePress).not.toHaveBeenCalled();
  });

  it("marks everything read and keeps going when one host fails", async () => {
    const clearA = vi.fn().mockRejectedValue(new Error("host offline"));
    const clearB = vi.fn().mockResolvedValue(undefined);
    clients.set("host-a", { clearAgentAttention: clearA });
    clients.set("host-b", { clearAgentAttention: clearB });
    seed({
      "host-a": [finishedAgent("a1", 1), finishedAgent("a2", 2)],
      "host-b": [finishedAgent("b1", 3)],
    });
    renderSection();

    await act(async () => {
      view().getByTestId("sidebar-unread-conclusions-mark-all-read").click();
    });

    expect(clearA.mock.calls.map(([id]) => id).sort()).toEqual(["a1", "a2"]);
    expect(clearB).toHaveBeenCalledWith("b1");
  });

  it("resolves cross-host badges autonomously when the workspace list below is filtered to one host", () => {
    mockHosts.current = [
      {
        serverId: "host-a",
        label: "Mac Studio",
        appearance: { color: "blue", badgeDisplay: "name" },
      },
      {
        serverId: "host-b",
        label: "Linux Box",
        appearance: { color: "emerald", badgeDisplay: "name" },
      },
    ];
    seed({
      "host-a": [finishedAgent("a1", 2)],
      "host-b": [finishedAgent("b1", 1)],
    });
    // Empty external map simulates a single-host workspace filter in the list below.
    renderSection(undefined, new Map());

    expect(view().getByText("Mac Studio")).toBeTruthy();
    expect(view().getByText("Linux Box")).toBeTruthy();
  });

  it("reveals the mark-read action on keyboard focus or hover and drops cleared rows", async () => {
    const clearA = vi.fn().mockImplementation(async (agentId: string) => {
      const current = useSessionStore.getState().sessions;
      const hostSession = current["host-a"];
      if (!hostSession) return;
      const nextAgents = new Map(hostSession.agents);
      const target = nextAgents.get(agentId);
      if (target) {
        nextAgents.set(agentId, { ...target, requiresAttention: false, attentionReason: null });
      }
      useSessionStore.setState({
        sessions: { ...current, "host-a": { ...hostSession, agents: nextAgents } },
      });
    });
    clients.set("host-a", { clearAgentAttention: clearA });
    seed({
      "host-a": [finishedAgent("a1", 2)],
      "host-b": [finishedAgent("b1", 1)],
    });
    renderSection();

    const row = view().getByTestId("sidebar-unread-conclusion-row-host-a-a1");
    const button = view().getByTestId("sidebar-unread-conclusion-mark-read-host-a-a1");
    const overlay = view().getByTestId("sidebar-unread-conclusion-mark-read-overlay-host-a-a1");

    expect(window.getComputedStyle(overlay).opacity).toBe("0");
    expect(window.getComputedStyle(overlay).pointerEvents).toBe("none");

    // The mark-read action is reachable in the natural Tab order (not removed via tabIndex=-1)
    // and reveals itself when focused.
    expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    act(() => {
      button.focus();
    });
    expect(document.activeElement).toBe(button);
    expect(window.getComputedStyle(overlay).opacity).toBe("1");
    expect(window.getComputedStyle(overlay).pointerEvents).toBe("auto");

    act(() => {
      button.blur();
    });
    expect(window.getComputedStyle(overlay).opacity).toBe("0");

    // React DOM synthesizes `onPointerEnter`/`onPointerLeave` from bubbling `pointerover`/`pointerout`.
    act(() => {
      row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    expect(window.getComputedStyle(overlay).opacity).toBe("1");
    expect(window.getComputedStyle(overlay).pointerEvents).toBe("auto");

    act(() => {
      row.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    });
    expect(window.getComputedStyle(overlay).opacity).toBe("0");

    act(() => {
      row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    expect(window.getComputedStyle(overlay).opacity).toBe("1");

    await act(async () => {
      button.click();
    });

    expect(clearA).toHaveBeenCalledWith("a1");
    expect(view().queryByTestId("sidebar-unread-conclusion-row-host-a-a1")).toBeNull();
    expect(view().getByTestId("sidebar-unread-conclusion-row-host-b-b1")).toBeTruthy();
  });
});
