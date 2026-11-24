import { within } from "@testing-library/dom";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Text } from "react-native";
import { expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { i18n } from "@/i18n/i18next";
import { WorkspaceDeferralPage } from "./sidebar-workspace-deferral-menu";

const writes = vi.hoisted(() => ({
  setWorkspaceDeferral: vi.fn(),
  setAgentLimitRecovery: vi.fn(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: (serverId: string) =>
      serverId === "test-deferral-host"
        ? {
            getConnectionState: () => ({ status: "connected" }),
            ...writes,
          }
        : null,
  }),
  useHostRuntimeConnectionStatus: () => "online",
}));

it("restores through workspace RPC only and retains the replicated state while awaiting confirmation", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  const serverId = "test-deferral-host";
  const workspaceId = "same-id";
  const store = useSessionStore.getState();
  const pending = Promise.withResolvers<void>();
  writes.setWorkspaceDeferral.mockReset();
  writes.setWorkspaceDeferral.mockReturnValueOnce(pending.promise);
  writes.setAgentLimitRecovery.mockClear();
  store.initializeSession(serverId, null);
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: null,
    features: { workspaceDeferral: true },
  });
  const payload: WorkspaceDescriptorPayload = {
    id: workspaceId,
    projectId: "project",
    name: "workspace",
    projectKind: "git",
    workspaceKind: "worktree",
    projectDisplayName: "project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo/test",
    status: "done",
    statusEnteredAt: null,
    activityAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
  const publish = (row: WorkspaceDescriptorPayload) =>
    store.setWorkspaces(serverId, new Map([[workspaceId, normalizeWorkspaceDescriptor(row)]]));
  publish({ ...payload, parkedAt: "2026-11-24T00:00:00.000Z" });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const view = within(document.body);
  try {
    act(() =>
      root.render(
        <DropdownMenu open>
          <DropdownMenuTrigger>
            <Text>Menu</Text>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <WorkspaceDeferralPage serverId={serverId} workspaceId={workspaceId} />
          </DropdownMenuContent>
        </DropdownMenu>,
      ),
    );
    await vi.waitFor(() => expect(view.getByTestId("workspace-deferral-restore")).toBeTruthy());
    act(() => view.getByTestId("workspace-deferral-restore").click());
    expect(writes.setWorkspaceDeferral).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      action: "restore",
    });
    expect(writes.setAgentLimitRecovery).not.toHaveBeenCalled();
    expect(view.queryByTestId("workspace-deferral-park")).toBeNull();
    await act(async () => pending.resolve());
    expect(view.getByTestId("workspace-deferral-restore")).toBeTruthy();
    act(() => publish(payload));
    expect(view.queryByTestId("workspace-deferral-restore")).toBeNull();
    expect(view.getByTestId("workspace-deferral-park")).toBeTruthy();
  } finally {
    act(() => root.unmount());
    store.clearSession(serverId);
    container.remove();
    vi.unstubAllGlobals();
  }
});
