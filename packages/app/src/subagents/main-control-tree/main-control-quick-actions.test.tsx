/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lockHandoffInput } from "@/composer/handoff-input-lock";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { MainControlQuickActions } from "./main-control-quick-actions";

const runtime = vi.hoisted(() => {
  const client = { summarizeWorkspaceAgents: vi.fn(), sendAgentMessage: vi.fn() };
  return {
    client,
    serverInfo: { features: { workspaceAgentsSummary: true } },
    agents: new Map(),
    toastError: vi.fn(),
  };
});
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("@/stores/session-store", () => {
  const read = () => ({ sessions: { host: runtime } });
  return {
    useSessionStore: Object.assign(
      (select: (state: ReturnType<typeof read>) => unknown) => select(read()),
      {
        getState: read,
      },
    ),
  };
});
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: runtime.toastError }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en" } }),
}));

const attachment = {
  type: "text",
  text: "Workspace progress",
  title: "Workspace sessions summary",
};
const main = {
  id: "main",
  workspaceId: "workspace",
  labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
};

function renderActions() {
  const onPromptSent = vi.fn();
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MainControlQuickActions
        mainAgentId="main"
        serverId="host"
        workspaceId="workspace"
        onPromptSent={onPromptSent}
      />
    </QueryClientProvider>,
  );
  return onPromptSent;
}

describe("Main Control quick actions", () => {
  beforeEach(() => {
    runtime.serverInfo.features.workspaceAgentsSummary = true;
    runtime.agents.set(main.id, main);
    runtime.client.summarizeWorkspaceAgents.mockResolvedValue({ attachment });
  });

  afterEach(() => {
    cleanup();
    runtime.agents.clear();
    vi.resetAllMocks();
  });

  it.each([
    ["Summarize all sessions", /completed work/],
    ["Audit uncommitted changes", /including staged changes/],
  ] as const)(
    "sends the %s prompt with the summary and blocks double clicks",
    async (label, prompt) => {
      const onPromptSent = renderActions();
      const button = screen.getByRole("button", { name: label });
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(onPromptSent).toHaveBeenCalledOnce());
      expect(runtime.client.summarizeWorkspaceAgents).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "workspace",
      });
      expect(runtime.client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith(
        "main",
        expect.stringMatching(prompt),
        {
          attachments: [attachment],
        },
      );
    },
  );

  it("shows an error and allows retrying a failed summary", async () => {
    runtime.client.summarizeWorkspaceAgents.mockRejectedValueOnce(new Error("Summary failed"));
    const onPromptSent = renderActions();
    const button = screen.getByRole("button", { name: "Summarize all sessions" });
    fireEvent.click(button);
    await waitFor(() => expect(runtime.toastError).toHaveBeenCalledWith("Summary failed"));
    expect(runtime.client.sendAgentMessage).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(onPromptSent).toHaveBeenCalledOnce());
  });

  it("drops a summary if the main session was archived while it was loading", async () => {
    runtime.client.summarizeWorkspaceAgents.mockImplementationOnce(async () => {
      runtime.agents.set(main.id, { ...main, archivedAt: new Date() });
      return { attachment };
    });
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Summarize all sessions" }));
    await waitFor(() =>
      expect(runtime.toastError).toHaveBeenCalledWith("The main session changed. Try again."),
    );
    expect(runtime.client.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("blocks a summary already in progress from sending during a provider switch", async () => {
    const pending = Promise.withResolvers<{ attachment: typeof attachment }>();
    runtime.client.summarizeWorkspaceAgents.mockReturnValueOnce(pending.promise);
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Summarize all sessions" }));
    let unlock: (() => void) | null = null;
    act(() => {
      unlock = lockHandoffInput(buildDraftStoreKey({ serverId: "host", agentId: "main" }));
    });
    if (!unlock) throw new Error("Expected the provider switch to acquire the lock");
    const release = unlock as () => void;
    try {
      pending.resolve({ attachment });
      await waitFor(() =>
        expect(runtime.toastError).toHaveBeenCalledWith(
          "The session is sending a message or switching providers. Try again.",
        ),
      );
      expect(runtime.client.sendAgentMessage).not.toHaveBeenCalled();
    } finally {
      act(() => release());
    }
  });

  it("hides the pills on a host without workspace summaries", () => {
    runtime.serverInfo.features.workspaceAgentsSummary = false;
    renderActions();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
