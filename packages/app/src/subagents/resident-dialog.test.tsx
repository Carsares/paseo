/** @vitest-environment jsdom */
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { RESIDENT_AGENT_LABEL } from "@getpaseo/protocol/agent-labels";
import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, type ChangeEvent, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { ResidentDialogProvider, useResidentActions } from "./resident-dialog";
import type { ResidentAction } from "./resident-actions";

const runtime = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/runtime/host-runtime", async (original) => ({
  ...(await original<typeof import("@/runtime/host-runtime")>()),
  useHostRuntimeClient: runtime.client,
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  SheetHeaderSubtitle: () => null,
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: (props: {
    value: boolean;
    accessibilityLabel: string;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }) => {
    const { onValueChange } = props;
    const change = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => onValueChange(event.currentTarget.checked),
      [onValueChange],
    );
    return (
      <input
        type="checkbox"
        aria-label={props.accessibilityLabel}
        checked={props.value}
        disabled={props.disabled}
        onChange={change}
      />
    );
  },
}));
vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const host = "specialist-host";
const target = "specialist";

function ActionButton({ action }: { action: ResidentAction }) {
  const item = useResidentActions(host, target).find((entry) => entry.action === action);
  return item ? (
    <button type="button" onClick={item.onSelect}>
      {action}
    </button>
  ) : null;
}

function renderResidentAction(action: ResidentAction) {
  let permissions: ServerInfoStatusPayload["permissions"] = ["workspace.write", "hub.execute"];
  const client = {
    getLastServerInfoMessage: () => ({ permissions }),
    resetAgentSession: vi.fn(async () => {}),
    setAgentResident: vi.fn(async () => {}),
  };
  runtime.client.mockImplementation((serverId: string) => (serverId === host ? client : null));
  const store = useSessionStore.getState();
  store.initializeSession(host, client as unknown as DaemonClient);
  store.setAgents(
    host,
    new Map([
      [
        target,
        {
          id: target,
          serverId: host,
          provider: "codex",
          cwd: "/workspace",
          model: null,
          createdAt: new Date(0),
          lastUserMessageAt: null,
          lastActivityAt: new Date(0),
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
          title: "Specialist",
          workspaceId: "workspace",
          parentAgentId: null,
          status: "closed",
          turn: { phase: "idle", cancellationRequestId: null },
          updatedAt: new Date(0),
          pendingPermissions: [],
          labels: { [RESIDENT_AGENT_LABEL]: "true" },
        } satisfies Agent,
      ],
    ]),
  );
  store.updateSessionServerInfo(host, {
    serverId: host,
    hostname: null,
    version: null,
    features: { agentResidentSpecialists: true, agentSessionReset: true },
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResidentDialogProvider>
        <ActionButton action={action} />
      </ResidentDialogProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: action }));
  return {
    client,
    setPermissions: (next: typeof permissions) => {
      permissions = next;
    },
  };
}

afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession(host);
  vi.clearAllMocks();
});

it("only clears the visible timeline after the user opts in and confirms the reset", async () => {
  const { client } = renderResidentAction("reset");
  const clear = screen.getByRole<HTMLInputElement>("checkbox", {
    name: "subagents.resident.clearVisibleTimeline",
  });
  expect(clear.checked).toBe(false);
  fireEvent.click(clear);
  expect(client.resetAgentSession).not.toHaveBeenCalled();
  expect(screen.getByText("subagents.resident.clearVisibleTimelineDescription")).toBeTruthy();

  fireEvent.click(screen.getByTestId("resident-confirm"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(client.resetAgentSession).toHaveBeenCalledExactlyOnceWith(target, {
    interrupt: false,
    clearVisibleTimeline: true,
  });
});

it("rechecks permission at confirmation and keeps the error in the dialog", async () => {
  const { client, setPermissions } = renderResidentAction("reset");
  setPermissions(["workspace.write"]);
  fireEvent.click(screen.getByTestId("resident-confirm"));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(client.resetAgentSession).not.toHaveBeenCalled();
});

it("allows unbinding a parentless specialist and updates eligibility if it becomes archived", () => {
  const { client } = renderResidentAction("unbind");
  expect(screen.queryByText("subagents.resident.unbindDescription")).toBeNull();
  expect(screen.getByTestId("resident-confirm")).toBeTruthy();

  act(() => {
    useSessionStore.getState().setAgents(host, (agents) => {
      const next = new Map(agents);
      const specialist = agents.get(target);
      if (!specialist) throw new Error("Expected specialist");
      next.set(target, { ...specialist, archivedAt: new Date(1) });
      return next;
    });
  });
  expect(screen.queryByTestId("resident-confirm")).toBeNull();
  expect(client.setAgentResident).not.toHaveBeenCalled();
});
