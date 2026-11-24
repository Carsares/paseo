import { within } from "@testing-library/dom";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { AgentLimitRecovery } from "./agent-limit-recovery";

const target = { serverId: "limit-host", workspaceId: "workspace", agentId: "agent" };
const setAgentLimitRecovery = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: (serverId: string) =>
      serverId === "limit-host"
        ? {
            getConnectionState: () => ({ status: "connected" }),
            setAgentLimitRecovery,
          }
        : null,
  }),
  useHostRuntimeConnectionStatus: () => "online",
}));

function publishAgent(patch: Partial<AgentSnapshotPayload> = {}) {
  const agent = normalizeAgentSnapshot(
    {
      id: target.agentId,
      workspaceId: target.workspaceId,
      cwd: "/repo",
      provider: "codex",
      model: null,
      status: "error",
      lastError: "Request failed",
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
      lastUserMessageAt: null,
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      ...patch,
    },
    target.serverId,
  );
  useSessionStore.getState().setAgents(target.serverId, new Map([[target.agentId, agent]]));
}

it("sends only for the current failed turn and follows authoritative scheduled and unknown states", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  const store = useSessionStore.getState();
  store.initializeSession(target.serverId, null);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const view = within(container);
  const resetsAt = new Date(Date.now() + 60_000).toISOString();
  const conversationLimit = { turnId: "turn-a", limitId: "limit", resetsAt };
  const request = Promise.withResolvers<void>();
  setAgentLimitRecovery.mockReset();
  setAgentLimitRecovery.mockReturnValueOnce(request.promise);
  try {
    publishAgent({ conversationLimit });
    act(() => root.render(<AgentLimitRecovery {...target} />));
    expect(view.queryByTestId("agent-limit-recovery")).toBeNull();
    act(() => {
      store.updateSessionServerInfo(target.serverId, {
        serverId: target.serverId,
        hostname: null,
        version: null,
        features: { workspaceDeferral: true },
      });
      publishAgent();
    });
    expect(view.queryByTestId("agent-limit-recovery")).toBeNull();
    act(() =>
      publishAgent({
        conversationLimit: { ...conversationLimit, resetsAt: "2000-01-01T00:00:00.000Z" },
      }),
    );
    expect(view.queryByTestId("agent-limit-recovery")).toBeNull();

    act(() => publishAgent({ conversationLimit }));
    const proceed = view.getByTestId("agent-limit-recovery-continue");
    act(() => {
      proceed.click();
      proceed.click();
    });
    expect(setAgentLimitRecovery).toHaveBeenCalledExactlyOnceWith({
      workspaceId: target.workspaceId,
      agentId: target.agentId,
      turnId: conversationLimit.turnId,
      action: "continue",
    });
    await act(async () => request.reject(new Error("Workspace changed in another window")));
    expect(view.getByTestId("agent-limit-recovery-feedback").textContent).toContain(
      "Workspace changed in another window",
    );
    act(() =>
      publishAgent({
        conversationLimit,
        rateLimitContinuation: {
          turnId: conversationLimit.turnId,
          runAt: resetsAt,
          status: "scheduled",
        },
      }),
    );
    expect(view.queryByTestId("agent-limit-recovery-continue")).toBeNull();
    expect(view.getByTestId("agent-limit-recovery-cancel")).toBeTruthy();
    act(() =>
      publishAgent({
        rateLimitContinuation: {
          turnId: conversationLimit.turnId,
          runAt: resetsAt,
          status: "unknown",
        },
      }),
    );
    expect(view.queryByTestId("agent-limit-recovery-cancel")).toBeNull();
    expect(view.getByTestId("agent-limit-recovery").textContent).toContain(
      i18n.t("agentPanel.limitRecovery.unknown", {
        time: new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(resetsAt),
        ),
      }),
    );
    act(() => publishAgent({ conversationLimit, workspaceId: "other-workspace" }));
    expect(view.queryByTestId("agent-limit-recovery")).toBeNull();
  } finally {
    act(() => root.unmount());
    store.clearSession(target.serverId);
    container.remove();
    vi.unstubAllGlobals();
  }
});
