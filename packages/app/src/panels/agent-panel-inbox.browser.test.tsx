import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import type { PendingSubagentInbox } from "@getpaseo/protocol/messages";
import { within } from "@testing-library/dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
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
  useSessionStore.getState().setAgents(serverId, new Map([[agentId, agent]]));
}

it("gates inbox controls, suppresses a second click, retries after failure and clears on snapshot", async () => {
  await i18n.changeLanguage("en");
  const rejected = Promise.withResolvers<void>();
  const retried = Promise.withResolvers<void>();
  const flushAgentInbox = vi
    .fn<DaemonClient["flushAgentInbox"]>()
    .mockReturnValueOnce(rejected.promise)
    .mockReturnValueOnce(retried.promise);
  const store = useSessionStore.getState();
  store.initializeSession(serverId, { flushAgentInbox } as unknown as DaemonClient);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const view = within(container);
  try {
    publishAgent(true, inbox);
    act(() => root.render(<PendingSubagentInboxBar serverId={serverId} agentId={agentId} />));
    expect(view.queryByTestId("pending-subagent-inbox")).toBeNull();
    act(() => {
      publishAgent(false, inbox);
      store.updateSessionServerInfo(serverId, {
        serverId,
        hostname: null,
        version: null,
        features: { subagentInbox: true },
      });
    });
    expect(view.queryByTestId("pending-subagent-inbox")).toBeNull();

    act(() => publishAgent(true, inbox));
    expect(view.getByText("2 pending reports")).toBeTruthy();
    expect(view.getByText("Reviewer, subagent…")).toBeTruthy();
    const button = view.getByRole("button", { name: "Summarize now" });
    act(() => {
      button.click();
      button.click();
    });
    expect(flushAgentInbox).toHaveBeenCalledExactlyOnceWith(agentId);
    expect(view.getByRole("button", { name: "Summarizing…" })).toHaveProperty("disabled", true);
    await act(async () => rejected.reject(new Error("Connection lost")));
    expect(view.getByRole("alert").textContent).toContain("Retry");

    act(() => view.getByRole("button", { name: "Summarize now" }).click());
    expect(flushAgentInbox).toHaveBeenCalledTimes(2);
    act(() => publishAgent(true));
    expect(view.queryByTestId("pending-subagent-inbox")).toBeNull();
    await act(async () => retried.resolve());
  } finally {
    act(() => root.unmount());
    store.clearSession(serverId);
    container.remove();
  }
});
