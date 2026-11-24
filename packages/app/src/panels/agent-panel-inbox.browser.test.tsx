import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import type { PendingSubagentInbox } from "@getpaseo/protocol/messages";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { within } from "@testing-library/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CHAT_OUTLINE_GUTTER_INSET,
  CHAT_OUTLINE_MIN_PANEL_WIDTH,
} from "@/agent-stream/chat-outline/geometry";
import { CHAT_COLUMN_RAIL_DATASET, ChatColumnRailSurface } from "@/chat-rail";
import { ToastProvider } from "@/contexts/toast-context";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_APP_SETTINGS } from "@/hooks/use-settings/storage";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { PendingSubagentInboxBar } from "./agent-panel-inbox";

const serverId = "inbox-host";
const agentId = "inbox-agent";
const inbox: PendingSubagentInbox = {
  count: 2,
  items: [
    { agentId: "reviewer", title: "Reviewer", event: "finished" },
    { agentId: "subagent-123456", event: "finished" },
  ],
};
const store = useSessionStore.getState();
let container: HTMLDivElement;
let root: Root;
let view: ReturnType<typeof within>;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.body.appendChild(document.createElement("div"));
  container.style.width = "1000px";
  root = createRoot(container);
  view = within(container);
});

afterEach(() => {
  act(() => root.unmount());
  store.clearSession(serverId);
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

function publishAgent(isMain: boolean, pendingSubagentInbox?: PendingSubagentInbox) {
  const agent = normalizeAgentSnapshot(
    {
      id: agentId,
      provider: "codex",
      cwd: "/repo",
      model: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:01:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
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
