import { describe, expect, it, vi } from "vitest";
import { AfterPaintPublication } from "@/composer/after-paint-publication";
import type { DraftInput } from "@/stores/draft-store";
import {
  canSwitchAgentProvider,
  performCrossProviderAgentHandoff,
  type CrossProviderHandoffSelection,
} from "./cross-provider-handoff";

// Keep the shared history builder and close policy real while isolating the hook's app wiring.
vi.mock("expo-router", () => ({ useRouter: vi.fn() }));
vi.mock("@/hooks/use-archive-agent", () => ({ applyArchivedAgentCloseResults: vi.fn() }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({ navigateToWorkspace: vi.fn() }));
vi.mock("@/stores/draft-store", () => ({ useDraftStore: vi.fn() }));
vi.mock("@/stores/session-store", () => ({ useSessionStore: vi.fn() }));
vi.mock("@/stores/workspace-layout-store", () => ({ useWorkspaceLayoutStore: vi.fn() }));
vi.mock("@/subagents", () => import("@/subagents/close-tab-policy"));
vi.mock("@/utils/client-id", () => ({ getOrCreateClientId: vi.fn() }));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

type Deps = Parameters<typeof performCrossProviderAgentHandoff>[1];
type ForkPayload = Awaited<ReturnType<NonNullable<Deps["client"]>["buildAgentForkContext"]>>;

const forkPayload: ForkPayload = {
  requestId: "fork-request",
  agentId: "agent-1",
  attachment: {
    type: "text",
    mimeType: "text/plain",
    contextKind: "chat_history",
    text: "User: Diagnose the issue.\nAssistant: I found a partial result.",
  },
  boundaryMessageId: null,
  itemCount: 2,
  error: null,
};

const sourceDraftKey = "agent:host-1:agent-1";
const targetDraftKey = "draft:host-1:draft-1";
const draftAttachmentScopeKey = "workspace-attachments:draft=draft-1";
const workspaceKey = "host-1:workspace-1";
const mainControlLabels = { "paseo.workspace-role": "main" };

const confirmation = {
  title: "workspace.tabs.confirmations.archiveRunningAgentTitle",
  message: "workspace.tabs.confirmations.archiveRunningAgentMessage",
  confirmLabel: "workspace.tabs.confirmations.archive",
  cancelLabel: "workspace.tabs.confirmations.cancel",
  destructive: true,
};

function createHandoff(agentOverrides: Partial<NonNullable<ReturnType<Deps["getAgent"]>>> = {}) {
  const agent: NonNullable<ReturnType<Deps["getAgent"]>> = {
    cwd: "/workspace/project",
    labels: {},
    parentAgentId: null,
    status: "idle",
    workspaceId: "workspace-1",
    ...agentOverrides,
  };
  const client = {
    buildAgentForkContext: vi.fn(async () => forkPayload),
    updateAgent: vi.fn(async () => {}),
  };
  const paneContext = {
    host: "main" as const,
    workspaceId: "workspace-1",
    tabId: "existing-tab",
    retargetCurrentTab: vi.fn(),
  };
  const storedDraft: DraftInput = {
    text: "Stored prompt",
    attachments: [{ kind: "workspace_file", path: "stored.ts", selection: { kind: "whole_file" } }],
  };
  const metadataByDraftKey: ReturnType<Deps["getDraftStore"]>["metadataByDraftKey"] = {
    [sourceDraftKey]: { review: { enabled: true } },
  };
  const draftStore = {
    getDraftInput: vi.fn<ReturnType<Deps["getDraftStore"]>["getDraftInput"]>(() => storedDraft),
    metadataByDraftKey,
    saveDraftInput: vi.fn(),
    patchDraftMetadata: vi.fn(),
    clearDraftInput: vi.fn(),
    clearDraftMetadata: vi.fn(),
  };
  const textPublication = new AfterPaintPublication<string>(
    (text) => {
      liveText = text;
    },
    { schedule: () => () => {} },
  );
  let liveText = "  Continue here.  ";
  const composerInput = {
    textSource: {
      getSnapshot: () => liveText,
      peekPendingText: () => textPublication.peek(),
      subscribe: () => () => {},
    },
    attachments: [
      { kind: "workspace_file", path: "live.ts", selection: { kind: "whole_file" } },
    ] satisfies DraftInput["attachments"],
    setText: vi.fn((next: string) => {
      textPublication.cancel();
      liveText = next;
    }),
  };
  const workspaceAttachmentsStore = { setWorkspaceAttachments: vi.fn() };
  const layoutStore = {
    getWorkspaceTabs: vi.fn<ReturnType<Deps["getWorkspaceLayoutStore"]>["getWorkspaceTabs"]>(() => [
      { tabId: paneContext.tabId, target: { kind: "agent", agentId: "agent-1" }, createdAt: 0 },
    ]),
    unpinAgent: vi.fn(),
    hideAgent: vi.fn(),
  };
  const deps = {
    supportsAgentForkContext: true,
    client,
    paneContext,
    getAgent: vi.fn<Deps["getAgent"]>(() => agent),
    getComposerInput: vi.fn<Deps["getComposerInput"]>(() => composerInput),
    getDraftStore: () => draftStore,
    getWorkspaceAttachmentsStore: () => workspaceAttachmentsStore,
    getWorkspaceLayoutStore: () => layoutStore,
    confirmDialog: vi.fn(async () => true),
    getOrCreateClientId: vi.fn(async () => "client-1"),
    generateDraftId: vi.fn(() => "draft-1"),
    archiveAgent: vi.fn(async () => {}),
    toast: { error: vi.fn() },
    t: (key: string) => key,
  } satisfies Deps;
  const run = (
    overrides: Partial<Deps> = {},
    selection: CrossProviderHandoffSelection = { provider: "codex" },
  ) =>
    performCrossProviderAgentHandoff(
      { serverId: "host-1", agentId: "agent-1", selection },
      { ...deps, ...overrides },
    );

  function expectSourceUntouched() {
    expect(workspaceAttachmentsStore.setWorkspaceAttachments).not.toHaveBeenCalled();
    expect(draftStore.saveDraftInput).not.toHaveBeenCalled();
    expect(draftStore.patchDraftMetadata).not.toHaveBeenCalled();
    expect(composerInput.setText).not.toHaveBeenCalled();
    expect(draftStore.clearDraftInput).not.toHaveBeenCalled();
    expect(draftStore.clearDraftMetadata).not.toHaveBeenCalled();
    expect(layoutStore.unpinAgent).not.toHaveBeenCalled();
    expect(layoutStore.hideAgent).not.toHaveBeenCalled();
    expect(paneContext.retargetCurrentTab).not.toHaveBeenCalled();
  }

  return {
    agent,
    client,
    paneContext,
    storedDraft,
    draftStore,
    composerInput,
    textPublication,
    workspaceAttachmentsStore,
    layoutStore,
    deps,
    run,
    expectSourceUntouched,
  };
}

describe("performCrossProviderAgentHandoff", () => {
  it("moves the live prompt and full chat history to a new draft in the current tab", async () => {
    const {
      client,
      paneContext,
      draftStore,
      composerInput,
      workspaceAttachmentsStore,
      layoutStore,
      deps,
      run,
    } = createHandoff();
    const providerOptions = { sandbox: "workspace-write" };

    expect(
      await run(
        {},
        {
          provider: "codex",
          modelId: " model-1 ",
          modeId: " mode-1 ",
          thinkingOptionId: " high ",
          providerOptions,
        },
      ),
    ).toBe(true);

    expect(deps.confirmDialog).not.toHaveBeenCalled();
    expect(client.buildAgentForkContext).toHaveBeenCalledExactlyOnceWith("agent-1");
    expect(workspaceAttachmentsStore.setWorkspaceAttachments).toHaveBeenCalledExactlyOnceWith({
      scopeKey: draftAttachmentScopeKey,
      attachments: [
        {
          kind: "chat_history",
          id: "chat_history:draft-1",
          attachment: { ...forkPayload.attachment, forkContext: { sourceAgentId: "agent-1" } },
          source: { serverId: "host-1", agentId: "agent-1", boundaryMessageId: null, itemCount: 2 },
        },
      ],
    });
    expect(draftStore.getDraftInput).toHaveBeenCalledExactlyOnceWith(sourceDraftKey);
    expect(draftStore.saveDraftInput).toHaveBeenCalledExactlyOnceWith({
      draftKey: targetDraftKey,
      draft: { text: "  Continue here.  ", attachments: composerInput.attachments },
    });
    expect(draftStore.patchDraftMetadata).toHaveBeenCalledExactlyOnceWith({
      draftKey: targetDraftKey,
      patch: { review: { enabled: true } },
    });
    expect(composerInput.setText).toHaveBeenCalledExactlyOnceWith("");
    expect(draftStore.clearDraftInput).toHaveBeenCalledExactlyOnceWith({
      draftKey: sourceDraftKey,
      lifecycle: "abandoned",
    });
    expect(draftStore.clearDraftMetadata).toHaveBeenCalledExactlyOnceWith({
      draftKey: sourceDraftKey,
    });
    expect(layoutStore.unpinAgent).toHaveBeenCalledExactlyOnceWith(workspaceKey, "agent-1");
    expect(layoutStore.hideAgent).toHaveBeenCalledExactlyOnceWith(workspaceKey, "agent-1");
    expect(paneContext.retargetCurrentTab).toHaveBeenCalledExactlyOnceWith({
      kind: "draft",
      draftId: "draft-1",
      setup: {
        provider: "codex",
        cwd: "/workspace/project",
        modeId: "mode-1",
        model: "model-1",
        thinkingOptionId: "high",
        providerOptions,
      },
    });
    expect(deps.archiveAgent).toHaveBeenCalledExactlyOnceWith({
      serverId: "host-1",
      agentId: "agent-1",
    });
    expect(client.buildAgentForkContext).toHaveBeenCalledBefore(
      workspaceAttachmentsStore.setWorkspaceAttachments,
    );
    expect(draftStore.saveDraftInput).toHaveBeenCalledBefore(draftStore.clearDraftInput);
    expect(workspaceAttachmentsStore.setWorkspaceAttachments).toHaveBeenCalledBefore(
      paneContext.retargetCurrentTab,
    );
    expect(layoutStore.hideAgent).toHaveBeenCalledBefore(paneContext.retargetCurrentTab);
    expect(deps.archiveAgent).toHaveBeenCalledBefore(
      workspaceAttachmentsStore.setWorkspaceAttachments,
    );
    expect(deps.toast.error).not.toHaveBeenCalled();
  });

  it.each(["The last keystroke", ""])("moves pending text %j before paint", async (text) => {
    const { draftStore, composerInput, textPublication, run } = createHandoff();
    let storeText = "  Continue here.  ";
    composerInput.textSource.getSnapshot = () => storeText;
    draftStore.clearDraftInput.mockImplementation(({ draftKey }) => {
      if (draftKey === sourceDraftKey) storeText = "";
    });
    composerInput.setText.mockImplementation((next: string) => {
      if (next === composerInput.textSource.getSnapshot()) {
        textPublication.cancel();
        return;
      }
      textPublication.stage(next);
    });
    textPublication.stage(text);
    expect(composerInput.textSource.getSnapshot()).toBe("  Continue here.  ");
    expect(await run()).toBe(true);
    expect(draftStore.saveDraftInput).toHaveBeenCalledExactlyOnceWith({
      draftKey: targetDraftKey,
      draft: { text, attachments: composerInput.attachments },
    });
    expect(textPublication.peek()).toBeNull();
  });

  it("keeps the stored prompt when there is no mounted composer input", async () => {
    const { storedDraft, draftStore, composerInput, run } = createHandoff();

    expect(await run({ getComposerInput: () => null })).toBe(true);

    expect(draftStore.saveDraftInput).toHaveBeenCalledExactlyOnceWith({
      draftKey: targetDraftKey,
      draft: storedDraft,
    });
    expect(composerInput.setText).not.toHaveBeenCalled();
  });

  it.each(["running", "initializing"] as const)(
    "leaves a %s root agent untouched if the user cancels",
    async (status) => {
      const { client, deps, run, expectSourceUntouched } = createHandoff({ status });
      deps.confirmDialog.mockResolvedValueOnce(false);

      expect(await run()).toBe(false);

      expect(deps.confirmDialog).toHaveBeenCalledExactlyOnceWith(confirmation);
      expect(client.buildAgentForkContext).not.toHaveBeenCalled();
      expect(client.updateAgent).not.toHaveBeenCalled();
      expect(deps.generateDraftId).not.toHaveBeenCalled();
      expect(deps.toast.error).not.toHaveBeenCalled();
      expectSourceUntouched();
    },
  );

  it("switches and archives a running root agent after confirmation", async () => {
    const { client, paneContext, deps, run } = createHandoff({ status: "running" });

    expect(await run()).toBe(true);

    expect(deps.confirmDialog).toHaveBeenCalledExactlyOnceWith(confirmation);
    expect(deps.confirmDialog).toHaveBeenCalledBefore(client.buildAgentForkContext);
    expect(paneContext.retargetCurrentTab).toHaveBeenCalledOnce();
    expect(deps.archiveAgent).toHaveBeenCalledExactlyOnceWith({
      serverId: "host-1",
      agentId: "agent-1",
    });
  });

  it("releases this client's open-tab label and keeps an attached subagent unarchived", async () => {
    const { agent, client, paneContext, deps, run } = createHandoff({
      parentAgentId: "parent-1",
      status: "running",
    });
    client.updateAgent.mockImplementationOnce(async () => {
      deps.getAgent.mockReturnValue({ ...agent, parentAgentId: "new-parent" });
    });

    expect(await run()).toBe(true);

    expect(deps.confirmDialog).not.toHaveBeenCalled();
    expect(client.updateAgent).toHaveBeenCalledExactlyOnceWith("agent-1", {
      labels: { "paseo.open-agent-tab.client-1": "false" },
    });
    expect(client.buildAgentForkContext).toHaveBeenCalledBefore(client.updateAgent);
    expect(client.updateAgent).toHaveBeenCalledBefore(paneContext.retargetCurrentTab);
    expect(paneContext.retargetCurrentTab).toHaveBeenCalledExactlyOnceWith({
      kind: "draft",
      draftId: "draft-1",
      setup: {
        provider: "codex",
        cwd: "/workspace/project",
        parentAgentId: "new-parent",
        modeId: null,
        model: null,
        thinkingOptionId: null,
        providerOptions: {},
      },
    });
    expect(deps.archiveAgent).not.toHaveBeenCalled();
  });

  it("archives a subagent that detaches during the label update", async () => {
    const { agent, client, paneContext, deps, run } = createHandoff({ parentAgentId: "parent-1" });
    client.updateAgent.mockImplementationOnce(async () => {
      deps.getAgent.mockReturnValue({ ...agent, parentAgentId: null });
    });

    expect(await run()).toBe(true);

    expect(client.updateAgent).toHaveBeenCalledExactlyOnceWith("agent-1", {
      labels: { "paseo.open-agent-tab.client-1": "false" },
    });
    expect(deps.archiveAgent).toHaveBeenCalledBefore(paneContext.retargetCurrentTab);
    expect(deps.archiveAgent).toHaveBeenCalledExactlyOnceWith({
      serverId: "host-1",
      agentId: "agent-1",
    });
  });

  it("keeps a main control agent and its draft untouched", async () => {
    const { client, deps, run, expectSourceUntouched } = createHandoff({
      labels: mainControlLabels,
    });
    expect(await run()).toBe(false);
    expect(client.buildAgentForkContext).not.toHaveBeenCalled();
    expect(deps.archiveAgent).not.toHaveBeenCalled();
    expectSourceUntouched();
  });

  it.each(["closed", "retargeted", "migrated", "archived", "removed"] as const)(
    "aborts if the source was %s while loading history",
    async (change) => {
      const { agent, client, deps, layoutStore, run, expectSourceUntouched } = createHandoff();
      client.buildAgentForkContext.mockImplementationOnce(async () => {
        switch (change) {
          case "closed":
            layoutStore.getWorkspaceTabs.mockReturnValue([]);
            break;
          case "retargeted":
            layoutStore.getWorkspaceTabs.mockReturnValue([
              {
                tabId: "existing-tab",
                target: { kind: "agent", agentId: "other-agent" },
                createdAt: 0,
              },
            ]);
            break;
          case "migrated":
            deps.getAgent.mockReturnValue({ ...agent, workspaceId: "other-workspace" });
            break;
          case "archived":
            deps.getAgent.mockReturnValue({ ...agent, archivedAt: new Date(1_000) });
            break;
          case "removed":
            deps.getAgent.mockReturnValue(null);
            break;
        }
        return forkPayload;
      });
      expect(await run()).toBe(false);
      expect(deps.archiveAgent).not.toHaveBeenCalled();
      expectSourceUntouched();
    },
  );

  it("does not update the label if the tab closes while obtaining the client ID", async () => {
    const { client, deps, layoutStore, run, expectSourceUntouched } = createHandoff({
      parentAgentId: "parent-1",
    });
    deps.getOrCreateClientId.mockImplementationOnce(async () => {
      layoutStore.getWorkspaceTabs.mockReturnValue([]);
      return "client-1";
    });
    expect(await run()).toBe(false);
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(deps.archiveAgent).not.toHaveBeenCalled();
    expectSourceUntouched();
  });

  it("asks before archiving an agent that starts running and detaches during the label update", async () => {
    const { agent, client, deps, run, expectSourceUntouched } = createHandoff({
      parentAgentId: "parent-1",
    });
    client.updateAgent.mockImplementationOnce(async () => {
      deps.getAgent.mockReturnValue({ ...agent, parentAgentId: null, status: "running" });
    });
    deps.confirmDialog.mockResolvedValueOnce(false);
    expect(await run()).toBe(false);
    expect(deps.confirmDialog).toHaveBeenCalledExactlyOnceWith(confirmation);
    expect(deps.archiveAgent).not.toHaveBeenCalled();
    expectSourceUntouched();
  });

  it("leaves the source intact until archive succeeds and reports a failed archive", async () => {
    const { deps, run, expectSourceUntouched } = createHandoff();
    const archive = Promise.withResolvers<void>();
    deps.archiveAgent.mockReturnValueOnce(archive.promise);
    const handoff = run();
    await vi.waitFor(() => expect(deps.archiveAgent).toHaveBeenCalledOnce());
    expectSourceUntouched();
    archive.reject(new Error("Archive refused"));
    expect(await handoff).toBe(false);
    expectSourceUntouched();
    expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith("Archive refused");
  });

  it("shows a message on unsupported hosts and leaves the tab untouched", async () => {
    const { client, deps, run, expectSourceUntouched } = createHandoff();

    expect(await run({ supportsAgentForkContext: false })).toBe(false);

    expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith("message.actions.forkUnavailable");
    expect(client.buildAgentForkContext).not.toHaveBeenCalled();
    expectSourceUntouched();
  });

  it("shows the disconnected-host message when there is no client", async () => {
    const { deps, run, expectSourceUntouched } = createHandoff();

    expect(await run({ client: null })).toBe(false);

    expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith("workspace.terminal.hostDisconnected");
    expect(deps.getAgent).not.toHaveBeenCalled();
    expectSourceUntouched();
  });

  it("leaves the prompt and tab untouched when the host fails to build chat history", async () => {
    const { client, deps, run, expectSourceUntouched } = createHandoff({
      parentAgentId: "parent-1",
    });
    client.buildAgentForkContext.mockRejectedValueOnce(new Error("History unavailable"));

    expect(await run()).toBe(false);

    expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith("History unavailable");
    expect(client.updateAgent).not.toHaveBeenCalled();
    expectSourceUntouched();
  });

  it("shows the fork failure message when the host returns no attachment", async () => {
    const { client, deps, run, expectSourceUntouched } = createHandoff();
    client.buildAgentForkContext.mockResolvedValueOnce({ ...forkPayload, attachment: null });

    expect(await run()).toBe(false);

    expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith("message.actions.forkFailed");
    expectSourceUntouched();
  });

  it("migrates attachments-only drafts and skips draft persistence when prompt and metadata are empty", async () => {
    const { draftStore, composerInput, run } = createHandoff();
    composerInput.setText("");
    draftStore.metadataByDraftKey = {};

    expect(await run()).toBe(true);

    expect(draftStore.saveDraftInput).toHaveBeenCalledExactlyOnceWith({
      draftKey: targetDraftKey,
      draft: { text: "", attachments: composerInput.attachments },
    });
    expect(draftStore.patchDraftMetadata).not.toHaveBeenCalled();

    const emptyHandoff = createHandoff();
    emptyHandoff.composerInput.setText("");
    emptyHandoff.composerInput.attachments = [];
    emptyHandoff.draftStore.getDraftInput.mockReturnValue(undefined);
    emptyHandoff.draftStore.metadataByDraftKey = {};

    expect(await emptyHandoff.run()).toBe(true);

    expect(emptyHandoff.draftStore.saveDraftInput).not.toHaveBeenCalled();
    expect(emptyHandoff.draftStore.patchDraftMetadata).not.toHaveBeenCalled();
    expect(emptyHandoff.draftStore.clearDraftInput).toHaveBeenCalledExactlyOnceWith({
      draftKey: sourceDraftKey,
      lifecycle: "abandoned",
    });
    expect(emptyHandoff.draftStore.clearDraftMetadata).toHaveBeenCalledExactlyOnceWith({
      draftKey: sourceDraftKey,
    });
  });

  it("returns false without side effects when pane or agent cannot hand off", async () => {
    const { agent, client, paneContext, deps, run, expectSourceUntouched } = createHandoff();

    expect(await run({ paneContext: null })).toBe(false);
    expect(await run({ paneContext: { ...paneContext, host: "sheet" } })).toBe(false);
    expect(await run({ paneContext: { ...paneContext, workspaceId: "   " } })).toBe(false);
    expect(await run({ getAgent: () => null })).toBe(false);
    expect(await run({ getAgent: () => ({ ...agent, archivedAt: new Date(1_000) }) })).toBe(false);

    expect(client.buildAgentForkContext).not.toHaveBeenCalled();
    expect(deps.toast.error).not.toHaveBeenCalled();
    expectSourceUntouched();
  });

  it("ignores concurrent calls while in flight and always resets inFlight in finally", async () => {
    const { client, deps, run } = createHandoff({ status: "running" });
    const inFlight = { current: false };
    const dialog = Promise.withResolvers<boolean>();
    deps.confirmDialog.mockReturnValueOnce(dialog.promise);

    const first = run({ inFlight });
    expect(inFlight.current).toBe(true);
    expect(await run({ inFlight })).toBe(false);

    dialog.resolve(false);
    expect(await first).toBe(false);
    expect(inFlight.current).toBe(false);

    client.buildAgentForkContext.mockRejectedValueOnce(new Error("Boom"));
    expect(await run({ inFlight })).toBe(false);
    expect(inFlight.current).toBe(false);
  });
});

describe("canSwitchAgentProvider", () => {
  it("requires agentForkContext support, a connected client, and a non-sheet workspace pane", () => {
    const { agent, client, paneContext } = createHandoff();
    const input = { supportsAgentForkContext: true, client, paneContext, agent };
    expect(canSwitchAgentProvider(input)).toBe(true);
    expect(
      canSwitchAgentProvider({ ...input, paneContext: { ...paneContext, host: "explorer" } }),
    ).toBe(true);
    expect(canSwitchAgentProvider({ ...input, supportsAgentForkContext: false })).toBe(false);
    expect(canSwitchAgentProvider({ ...input, client: null })).toBe(false);
    expect(canSwitchAgentProvider({ ...input, paneContext: null })).toBe(false);
    expect(
      canSwitchAgentProvider({ ...input, paneContext: { ...paneContext, host: "sheet" } }),
    ).toBe(false);
    expect(
      canSwitchAgentProvider({ ...input, paneContext: { ...paneContext, workspaceId: "   " } }),
    ).toBe(false);
    expect(canSwitchAgentProvider({ ...input, agent: { labels: mainControlLabels } })).toBe(false);
  });
});
