import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import { RewindMenu } from "./rewind-menu";
import { RewindFileRetry } from "./rewind-file-retry";
import { usePendingRewindFileRecovery, useRewindAgentMutation } from "./use-rewind-agent-mutation";

void i18n;
let mounted: ReturnType<typeof mount> | undefined;

function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (next: React.ReactElement) => act(() => root.render(next));
  render(element);
  return {
    render,
    close: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  mounted?.close();
  mounted = undefined;
  useSessionStore.getState().clearSession("checkpoint-test");
  vi.unstubAllGlobals();
});

const capabilities = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: true,
};
const allowedCheckpoint = { canRewindFiles: true, canRewindBoth: true };
const silentToast = { show: () => () => {}, error: () => {}, copied: () => {} };

test("the message menu offers file actions only after the checkpoint permits them", async () => {
  const onRewind = vi.fn();
  const props = { capabilities, onRewind, rewoundText: "A saved message" };
  mounted = mount(<RewindMenu {...props} />);
  await userEvent.click(page.getByTestId("rewind-menu-trigger"));

  await expect.element(page.getByTestId("rewind-menu-conversation")).toBeVisible();
  await expect.element(page.getByTestId("rewind-menu-files")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("rewind-menu-both")).not.toBeInTheDocument();

  mounted.render(<RewindMenu {...props} checkpoint={allowedCheckpoint} />);
  await expect.element(page.getByTestId("rewind-menu-files")).toBeVisible();
  await userEvent.click(page.getByTestId("rewind-menu-both"));
  expect(onRewind).toHaveBeenCalledWith({ mode: "both", rewoundText: "A saved message" });
});

test("partial success stays clear when a file-only retry fails", async () => {
  const retry = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("Another writer started"));
  mounted = mount(<RewindFileRetry conversationRewound detail="Files are busy" retry={retry} />);

  await expect
    .element(page.getByText("Conversation rewound. Files could not be restored."))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Retry file restore" }));
  await expect.element(page.getByText("Another writer started")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Retry file restore" })).toBeEnabled();
  expect(retry).toHaveBeenCalledOnce();
});

test.each([false, true])(
  "retry uses the operation ID on hosts with pending lookup = %s",
  async (supportsLookup) => {
    const serverId = "checkpoint-test";
    const agentId = "agent";
    const messageId = "message";
    const checkpointId = "checkpoint";
    const operation = {
      operationId: "operation",
      target: { checkpointId, messageId },
      backupCheckpointId: "backup",
      conversationRewound: true,
    };
    const restoreAgentRewindCheckpoint = vi
      .fn<DaemonClient["restoreAgentRewindCheckpoint"]>()
      .mockResolvedValue({
        agentId,
        requestId: "restore",
        ok: false,
        error: "Files are busy",
        operation: { ...operation, status: "files_pending" },
      });
    const retryAgentRewindFiles = vi.fn<DaemonClient["retryAgentRewindFiles"]>();
    if (supportsLookup) {
      retryAgentRewindFiles.mockRejectedValueOnce(new Error("Another writer started"));
    }
    retryAgentRewindFiles.mockResolvedValue({
      agentId,
      requestId: "retry",
      ok: true,
      error: null,
      operation: { ...operation, status: "files_restored" },
    });
    const getAgentRewindFileRecovery = vi
      .fn<DaemonClient["getAgentRewindFileRecovery"]>()
      .mockRejectedValue(new Error("Lookup failed"));
    const rewindAgent = vi.fn<DaemonClient["rewindAgent"]>();
    const client = Object.assign(
      new DaemonClient({ url: "ws://unused.test", clientId: serverId }),
      {
        restoreAgentRewindCheckpoint,
        retryAgentRewindFiles,
        rewindAgent,
        getAgentRewindFileRecovery,
        supportsPendingRewindFiles: () => supportsLookup,
      },
    );
    useSessionStore.getState().initializeSession(serverId, client);
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: null,
      features: { rewindCheckpoints: true, rewindPendingFiles: supportsLookup },
    });
    const query = new QueryClient();
    function Rewind() {
      const { rewindAgent: runRewind } = useRewindAgentMutation({
        serverId,
        agentId,
        messageId,
        client,
      });
      const rewindBoth = React.useCallback(() => {
        void runRewind({ mode: "both", rewoundText: "A saved message", checkpointId });
      }, [runRewind]);
      return (
        <button type="button" onClick={rewindBoth}>
          Rewind both
        </button>
      );
    }
    function Harness() {
      const [content, setContent] = React.useState<React.ReactNode>();
      const toast = React.useMemo(
        () => ({
          show: (next: React.ReactNode) => {
            setContent(next);
            return () => {};
          },
          error: setContent,
          copied: () => {},
        }),
        [],
      );
      return (
        <QueryClientProvider client={query}>
          <ToastApiProvider api={toast}>
            <Rewind />
            <Recovery />
            {content}
          </ToastApiProvider>
        </QueryClientProvider>
      );
    }
    function Recovery() {
      return usePendingRewindFileRecovery({ serverId, agentId, client, enabled: true });
    }
    mounted = mount(<Harness />);
    await userEvent.click(page.getByRole("button", { name: "Rewind both" }));
    await expect
      .element(page.getByText("Conversation rewound. Files could not be restored."))
      .toBeVisible();
    await expect.element(page.getByText("Files are busy")).toBeVisible();
    if (supportsLookup) {
      await expect
        .element(page.getByText("Could not check for pending file restores."))
        .toBeVisible();
      await userEvent.click(page.getByRole("button", { name: "Retry file restore" }));
      await expect.element(page.getByText("Another writer started")).toBeVisible();
      await expect.element(page.getByText("Files are busy")).toBeVisible();
    }
    await userEvent.click(page.getByRole("button", { name: "Retry file restore" }));
    await expect.element(page.getByText("Files restored.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Retry file restore" }))
      .not.toBeInTheDocument();
    expect(restoreAgentRewindCheckpoint).toHaveBeenCalledExactlyOnceWith({
      agentId,
      messageId,
      checkpointId,
      mode: "both",
    });
    expect(retryAgentRewindFiles.mock.calls).toEqual(
      Array.from({ length: supportsLookup ? 2 : 1 }, () => [
        { agentId, operationId: operation.operationId },
      ]),
    );
    expect(rewindAgent).not.toHaveBeenCalled();
    query.clear();
  },
);

test.each([false, true])(
  "a reopened conversation finds pending files with unconfirmed items = %s",
  async (hasUnconfirmed) => {
    const serverId = "checkpoint-test";
    const agentId = "agent";
    const operationId = "recovered-operation";
    const unconfirmedFileRewinds = hasUnconfirmed ? [{ operationId: "older-operation" }] : [];
    const getAgentRewindFileRecovery = vi
      .fn<DaemonClient["getAgentRewindFileRecovery"]>()
      .mockRejectedValueOnce(new Error("Lookup failed"))
      .mockResolvedValueOnce({
        pendingFiles: [{ operationId, conversationRewound: true }],
        unconfirmedFileRewinds,
      })
      .mockRejectedValue(new Error("Lookup failed again"));
    const retryAgentRewindFiles = vi.fn<DaemonClient["retryAgentRewindFiles"]>().mockResolvedValue({
      agentId,
      requestId: "retry",
      ok: true,
      error: null,
      operation: {
        operationId,
        target: { messageId: "removed-message", checkpointId: "checkpoint" },
        backupCheckpointId: "backup",
        conversationRewound: true,
        status: "files_restored",
      },
    });
    const restoreAgentRewindCheckpoint = vi.fn<DaemonClient["restoreAgentRewindCheckpoint"]>();
    const rewindAgent = vi.fn<DaemonClient["rewindAgent"]>();
    const client = Object.assign(
      new DaemonClient({ url: "ws://unused.test", clientId: serverId }),
      {
        getAgentRewindFileRecovery,
        retryAgentRewindFiles,
        restoreAgentRewindCheckpoint,
        rewindAgent,
      },
    );
    useSessionStore.getState().initializeSession(serverId, client);
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: null,
      features: { rewindCheckpoints: true, rewindPendingFiles: true },
    });
    const query = new QueryClient();
    function ReopenedConversation() {
      return usePendingRewindFileRecovery({ serverId, agentId, client, enabled: true });
    }
    mounted = mount(
      <QueryClientProvider client={query}>
        <ToastApiProvider api={silentToast}>
          <ReopenedConversation />
        </ToastApiProvider>
      </QueryClientProvider>,
    );
    await expect
      .element(page.getByText("Could not check for pending file restores."))
      .toBeVisible();
    await userEvent.click(
      page.getByRole("button", { name: "Check again for pending file restores" }),
    );
    await expect
      .element(page.getByText("Conversation rewound. Files could not be restored."))
      .toBeVisible();
    const unconfirmed = page.getByText(
      "Could not confirm the conversation rewind. Files were not restored.",
    );
    if (hasUnconfirmed) {
      await expect.element(unconfirmed).toBeVisible();
    } else {
      await expect.element(unconfirmed).not.toBeInTheDocument();
    }
    const retry = page.getByRole("button", { name: "Retry file restore" });
    await userEvent.click(retry);
    await expect.element(retry).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Could not check for pending file restores."))
      .toBeVisible();
    if (hasUnconfirmed) await expect.element(unconfirmed).toBeVisible();
    expect(getAgentRewindFileRecovery).toHaveBeenCalledWith(agentId);
    expect(retryAgentRewindFiles).toHaveBeenCalledExactlyOnceWith({ agentId, operationId });
    expect(restoreAgentRewindCheckpoint).not.toHaveBeenCalled();
    expect(rewindAgent).not.toHaveBeenCalled();
    query.clear();
  },
);
