import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { collectRetainedAttachmentIds } from "@/attachments/gc-retention";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import { garbageCollectAttachments } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { AfterPaintPublication } from "@/composer/after-paint-publication";
import { beginComposerWork, isHandoffInputLocked } from "@/composer/handoff-input-lock";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import type { DraftInput } from "@/stores/draft-store";
import { createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
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
vi.mock("@/stores/session-store", () => ({
  useSessionStore: { getState: () => ({ sessions: {} }) },
}));
vi.mock("@/subagents", () => import("@/subagents/close-tab-policy"));
vi.mock("@/utils/client-id", () => ({ getOrCreateClientId: vi.fn() }));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

afterEach(() => __setAttachmentStoreForTests(null));

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
    attachments: [{ kind: "workspace_file", path: "live.ts", selection: { kind: "whole_file" } }],
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
      cancelPendingText: vi.fn(() => textPublication.cancel()),
      subscribe: () => () => {},
    },
    attachments: storedDraft.attachments,
    isLocked: vi.fn(() => false),
  };
  const workspaceAttachmentsStore = {
    setWorkspaceAttachments: vi.fn(),
    addWorkspaceAttachment: vi.fn(),
  };
  const getWorkspaceTabs = vi.fn<() => WorkspaceTab[]>(() => [
    { tabId: paneContext.tabId, target: { kind: "agent", agentId: "agent-1" }, createdAt: 0 },
  ]);
  const layoutStore = {
    getWorkspaceTabs,
    retainAgentTabForHandoff: vi.fn<
      ReturnType<Deps["getWorkspaceLayoutStore"]>["retainAgentTabForHandoff"]
    >(() => ({
      isCurrent: () =>
        getWorkspaceTabs().some(
          (tab) =>
            tab.tabId === paneContext.tabId &&
            tab.target.kind === "agent" &&
            tab.target.agentId === "agent-1",
        ),
      release: vi.fn(),
    })),
    unpinAgent: vi.fn(),
    hideAgent: vi.fn(),
    openTab: vi.fn(() => "recovery-tab"),
  };
  const deps = {
    supportsAgentForkContext: true,
    supportsAgentInitialPromptOrigin: vi.fn(() => true),
    readOtherHosts: vi.fn<Deps["readOtherHosts"]>(async () => []),
    client,
    paneContext,
    getAgent: vi.fn<Deps["getAgent"]>(() => agent),
    hasUnsettledMessage: vi.fn(() => false),
    hasQueuedMessages: vi.fn(() => false),
    confirmSourceArchived: vi.fn<Deps["confirmSourceArchived"]>(async () => false),
    takeQueuedMessages: vi.fn<Deps["takeQueuedMessages"]>(() => ({
      messages: [],
      restore: vi.fn(() => true),
    })),
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
    expect(composerInput.textSource.cancelPendingText).not.toHaveBeenCalled();
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

type MainControlClient = NonNullable<Deps["mainControlClient"]>;
const atomicOptions = { handoffFromAgentId: "agent-1", archiveSource: true };

function createMainControlClient(lateChildId?: string) {
  const replacement = {
    id: "replacement",
    provider: "codex",
    cwd: "/workspace/project",
    workspaceId: "workspace-1",
    model: null,
    createdAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    labels: {},
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    lastUserMessageAt: null,
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
  } satisfies Awaited<ReturnType<MainControlClient["createAgent"]>>;
  const entry = (id: string, workspaceId = "workspace-1", archivedAt?: string) => ({
    agent: {
      id,
      workspaceId,
      archivedAt,
      labels: parentAddressLabels({ serverId: "host-1", agentId: "agent-1" }),
    },
  });
  return {
    fetchAgentHistory: vi
      .fn<NonNullable<Deps["mainControlClient"]>["fetchAgentHistory"]>()
      .mockResolvedValueOnce({
        entries: [entry("child-open"), entry("another-workspace", "workspace-2")],
        pageInfo: { nextCursor: "page-2", hasMore: true },
      } as Awaited<ReturnType<NonNullable<Deps["mainControlClient"]>["fetchAgentHistory"]>>)
      .mockResolvedValueOnce({
        entries: [entry("child-closed"), entry("child-archived", "workspace-1", "yesterday")],
        pageInfo: { nextCursor: null, hasMore: false },
      } as Awaited<ReturnType<NonNullable<Deps["mainControlClient"]>["fetchAgentHistory"]>>)
      .mockResolvedValueOnce({
        entries: lateChildId ? [entry(lateChildId)] : [],
        pageInfo: { nextCursor: null, hasMore: false },
      } as Awaited<ReturnType<NonNullable<Deps["mainControlClient"]>["fetchAgentHistory"]>>)
      .mockResolvedValue({
        requestId: "fetch-latest",
        entries: [],
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      }),
    createAgent: vi.fn<MainControlClient["createAgent"]>().mockResolvedValue(replacement),
    fetchAgent: vi.fn<MainControlClient["fetchAgent"]>().mockResolvedValue({
      agent: replacement,
      project: null,
    }),
    setAgentMainControl: vi.fn<MainControlClient["setAgentMainControl"]>(async () => ({
      enabled: true,
      workspaceId: "workspace-1",
    })),
    setAgentParent: vi.fn(async (_id: string, parentAgentId: string) => ({ parentAgentId })),
  };
}

describe("performCrossProviderAgentHandoff", () => {
  it("moves same-workspace direct children, including closed tabs, before archiving Main Control", async () => {
    const { deps, run, paneContext, draftStore, storedDraft } = createHandoff({
      labels: mainControlLabels,
    });
    const mainControlClient = createMainControlClient();

    expect(await run({ mainControlClient }, { provider: "pi" })).toBe(true);

    expect(mainControlClient.fetchAgentHistory).toHaveBeenCalledTimes(3);
    expect(mainControlClient.setAgentParent.mock.calls).toEqual([
      ["child-open", "replacement"],
      ["child-closed", "replacement"],
    ]);
    expect(mainControlClient.setAgentMainControl).toHaveBeenCalledWith(
      "replacement",
      true,
      atomicOptions,
    );
    expect(mainControlClient.setAgentMainControl).toHaveBeenCalledBefore(
      mainControlClient.setAgentParent,
    );
    expect(mainControlClient.setAgentParent).toHaveBeenCalledBefore(deps.archiveAgent);
    expect(mainControlClient.setAgentMainControl).toHaveBeenCalledBefore(deps.archiveAgent);
    expect(paneContext.retargetCurrentTab).toHaveBeenCalledWith({
      kind: "agent",
      agentId: "replacement",
    });
    expect(draftStore.saveDraftInput).toHaveBeenCalledWith({
      draftKey: "agent:host-1:replacement",
      draft: {
        text: "  Continue here.  ",
        attachments: [
          ...storedDraft.attachments,
          {
            kind: "quote",
            id: "chat_history:draft-1",
            text: forkPayload.attachment?.text,
          },
        ],
      },
    });
  });

  it("uses the atomic handoff without moving children or archiving the source again", async () => {
    const { deps, run, paneContext } = createHandoff({ labels: mainControlLabels });
    const mainControlClient = createMainControlClient();
    mainControlClient.setAgentMainControl.mockResolvedValueOnce({
      enabled: true,
      workspaceId: "workspace-1",
      archivedSource: true,
    });

    expect(await run({ mainControlClient })).toBe(true);
    expect(mainControlClient.setAgentMainControl).toHaveBeenCalledExactlyOnceWith(
      "replacement",
      true,
      atomicOptions,
    );
    expect(mainControlClient.fetchAgentHistory).not.toHaveBeenCalled();
    expect(mainControlClient.setAgentParent).not.toHaveBeenCalled();
    expect(deps.archiveAgent).not.toHaveBeenCalled();
    expect(paneContext.retargetCurrentTab).toHaveBeenCalledWith({
      kind: "agent",
      agentId: "replacement",
    });
  });

  it.each(["unreachable", "remote child"] as const)(
    "rejects the handoff before creating a replacement when there is an %s",
    async (reason) => {
      const { deps, run, expectSourceUntouched } = createHandoff({ labels: mainControlLabels });
      const mainControlClient = createMainControlClient();
      const remoteHistory = vi.fn<MainControlClient["fetchAgentHistory"]>().mockResolvedValue({
        requestId: "remote",
        entries: [
          {
            agent: {
              id: "remote-child",
              workspaceId: "remote-workspace",
              labels: parentAddressLabels({ serverId: "host-1", agentId: "agent-1" }),
            },
          },
        ],
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      } as Awaited<ReturnType<MainControlClient["fetchAgentHistory"]>>);
      deps.readOtherHosts.mockResolvedValueOnce([
        {
          serverId: "host-2",
          label: "Build host",
          client: reason === "unreachable" ? null : { fetchAgentHistory: remoteHistory },
          includeBackground: true,
        },
      ]);

      expect(await run({ mainControlClient })).toBe(false);
      expect(mainControlClient.createAgent).not.toHaveBeenCalled();
      expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith(
        reason === "unreachable"
          ? "Cannot check Main Control subagents on Build host: host is unreachable."
          : "Main Control has active subagents on Build host. Detach or archive them before switching providers.",
      );
      expectSourceUntouched();
    },
  );

  it("keeps the replacement when a moved child cannot be restored", async () => {
    const { deps, run } = createHandoff({ labels: mainControlLabels });
    const mainControlClient = createMainControlClient();
    mainControlClient.setAgentParent.mockImplementation(async (id, parentAgentId) => {
      if (id === "child-closed" && parentAgentId === "replacement")
        throw new Error("Cannot move child");
      if (id === "child-open" && parentAgentId === "agent-1")
        throw new Error("Cannot restore child");
      return { parentAgentId };
    });
    const history = mainControlClient.fetchAgentHistory;
    const originalPage = await history({ filter: {}, page: { limit: 200 } });
    const secondPage = await history({ filter: {}, page: { limit: 200 } });
    await history({ filter: {}, page: { limit: 200 } });
    const [child] = originalPage.entries;
    history
      .mockResolvedValueOnce(originalPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce({
        ...originalPage,
        entries: [
          {
            ...child,
            agent: {
              ...child.agent,
              labels: parentAddressLabels({ serverId: "host-1", agentId: "replacement" }),
            },
          },
        ],
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      });
    expect(await run({ mainControlClient })).toBe(false);
    expect(deps.archiveAgent).not.toHaveBeenCalled();
    expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/child-open restore failed.*still has subagents: child-open/),
    );
  });

  it("archives a verified empty replacement while reporting a failed restore reply", async () => {
    const { deps, run } = createHandoff({ labels: mainControlLabels });
    const mainControlClient = createMainControlClient();
    mainControlClient.setAgentParent.mockImplementation(async (id, parentAgentId) => {
      if (id === "child-closed" && parentAgentId === "replacement") {
        throw new Error("Cannot move child");
      }
      if (id === "child-open" && parentAgentId === "agent-1") {
        throw new Error("Restore reply lost");
      }
      return { parentAgentId };
    });
    expect(await run({ mainControlClient })).toBe(false);
    expect(deps.archiveAgent).toHaveBeenCalledExactlyOnceWith({
      serverId: "host-1",
      agentId: "replacement",
      expectedWorkspaceId: "workspace-1",
    });
    expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /child-open restore failed \(Restore reply lost\).*replacement replacement archived/,
      ),
    );
  });

  it("finishes a committed atomic handoff after the daemon reports a follow-up error", async () => {
    const { deps, run, paneContext } = createHandoff({ labels: mainControlLabels });
    const mainControlClient = createMainControlClient();
    const current = await mainControlClient.fetchAgent({ agentId: "replacement" });
    if (!current) throw new Error("Expected an existing replacement");
    mainControlClient.fetchAgent.mockResolvedValueOnce({
      ...current,
      agent: { ...current.agent, labels: mainControlLabels },
    });
    mainControlClient.setAgentMainControl.mockRejectedValueOnce(new Error("Runtime close failed"));
    deps.confirmSourceArchived.mockResolvedValueOnce(true);

    expect(await run({ mainControlClient })).toBe(true);
    expect(paneContext.retargetCurrentTab).toHaveBeenCalledExactlyOnceWith({
      kind: "agent",
      agentId: "replacement",
    });
    expect(mainControlClient.setAgentParent).not.toHaveBeenCalled();
    expect(deps.archiveAgent).not.toHaveBeenCalled();
    expect(deps.toast.error).not.toHaveBeenCalled();
  });

  it("keeps the replacement when a new prompt arrived before rollback cleanup", async () => {
    const { deps, run } = createHandoff({ labels: mainControlLabels });
    const mainControlClient = createMainControlClient();
    mainControlClient.setAgentMainControl.mockRejectedValueOnce(new Error("Promotion refused"));
    const current = await mainControlClient.fetchAgent({ agentId: "replacement" });
    if (!current) throw new Error("Expected an existing replacement");
    const { agent } = current;
    mainControlClient.fetchAgent.mockResolvedValueOnce({
      agent: { ...agent, lastUserMessageAt: "2026-11-20T00:00:00Z" },
      project: null,
    });
    mainControlClient.fetchAgentHistory.mockReset().mockResolvedValue({
      requestId: "check-children",
      entries: [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    });

    expect(await run({ mainControlClient })).toBe(false);
    expect(deps.archiveAgent).not.toHaveBeenCalled();
    expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("new activity"),
    );
  });

  it("keeps the old Main Control and restores moved children if a child cannot be moved", async () => {
    const { deps, run, expectSourceUntouched } = createHandoff({ labels: mainControlLabels });
    const mainControlClient = createMainControlClient();
    mainControlClient.setAgentParent.mockImplementation(async (id, parentAgentId) => {
      if (id === "child-closed" && parentAgentId === "replacement") {
        throw new Error("Cannot move child");
      }
      return { parentAgentId };
    });

    expect(await run({ mainControlClient })).toBe(false);
    expect(mainControlClient.setAgentParent).toHaveBeenCalledWith("child-open", "agent-1");
    expect(mainControlClient.setAgentMainControl.mock.calls).toEqual([
      ["replacement", true, atomicOptions],
      ["agent-1", true],
    ]);
    expect(deps.archiveAgent).toHaveBeenCalledExactlyOnceWith({
      serverId: "host-1",
      agentId: "replacement",
      expectedWorkspaceId: "workspace-1",
    });
    expectSourceUntouched();
  });

  it("restores the original role when the promotion reply is lost", async () => {
    const { deps, run, expectSourceUntouched } = createHandoff({ labels: mainControlLabels });
    const mainControlClient = createMainControlClient();
    mainControlClient.setAgentMainControl.mockRejectedValueOnce(
      new DaemonConnectionError("Promotion reply timed out", "DAEMON_REQUEST_TIMEOUT"),
    );

    expect(await run({ mainControlClient })).toBe(false);
    expect(mainControlClient.setAgentMainControl.mock.calls).toEqual([
      ["replacement", true, atomicOptions],
      ["agent-1", true],
    ]);
    expect(deps.archiveAgent).toHaveBeenCalledExactlyOnceWith({
      serverId: "host-1",
      agentId: "replacement",
      expectedWorkspaceId: "workspace-1",
    });
    expectSourceUntouched();
  });

  it("keeps the replacement when a lost reply leaves the source archive unconfirmed", async () => {
    const { deps, run } = createHandoff({ labels: mainControlLabels });
    const mainControlClient = createMainControlClient();
    mainControlClient.setAgentMainControl.mockRejectedValueOnce(
      new DaemonConnectionError("Promotion reply timed out", "DAEMON_REQUEST_TIMEOUT"),
    );
    deps.confirmSourceArchived.mockResolvedValueOnce(null);

    expect(await run({ mainControlClient })).toBe(false);
    expect(mainControlClient.setAgentMainControl).toHaveBeenCalledExactlyOnceWith(
      "replacement",
      true,
      atomicOptions,
    );
    expect(deps.archiveAgent).not.toHaveBeenCalled();
    expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Could not confirm whether the original Main Control was archived"),
    );
  });

  it("moves a child that joined during the first history scan before archiving", async () => {
    const { deps, run } = createHandoff({ labels: mainControlLabels });
    const mainControlClient = createMainControlClient("late-child");

    expect(await run({ mainControlClient })).toBe(true);
    expect(mainControlClient.setAgentParent).toHaveBeenLastCalledWith("late-child", "replacement");
    expect(mainControlClient.setAgentParent).toHaveBeenCalledBefore(deps.archiveAgent);
    expect(mainControlClient.fetchAgentHistory).toHaveBeenCalledTimes(4);
  });

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
    expect(composerInput.textSource.cancelPendingText).toHaveBeenCalledOnce();
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
        restoreChatHistory: true,
        modeId: "mode-1",
        model: "model-1",
        thinkingOptionId: "high",
        providerOptions,
      },
    });
    expect(deps.archiveAgent).toHaveBeenCalledExactlyOnceWith({
      serverId: "host-1",
      agentId: "agent-1",
      expectedWorkspaceId: "workspace-1",
    });
    expect(client.buildAgentForkContext).toHaveBeenCalledBefore(
      workspaceAttachmentsStore.setWorkspaceAttachments,
    );
    expect(draftStore.saveDraftInput).toHaveBeenCalledBefore(draftStore.clearDraftInput);
    expect(workspaceAttachmentsStore.setWorkspaceAttachments).toHaveBeenCalledBefore(
      paneContext.retargetCurrentTab,
    );
    expect(paneContext.retargetCurrentTab).toHaveBeenCalledBefore(layoutStore.hideAgent);
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
    expect(composerInput.textSource.cancelPendingText).not.toHaveBeenCalled();
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

  it("includes the response that arrives while archiving a running root agent", async () => {
    const { client, paneContext, deps, run, workspaceAttachmentsStore } = createHandoff({
      status: "running",
    });
    const finalText = "User: Investigate.\nAssistant: Last response before closing.";
    deps.archiveAgent.mockImplementationOnce(async () => {
      client.buildAgentForkContext.mockResolvedValueOnce({
        ...forkPayload,
        attachment: {
          type: "text",
          mimeType: "text/plain",
          contextKind: "chat_history",
          text: finalText,
        },
      });
    });

    expect(await run()).toBe(true);

    expect(deps.confirmDialog).toHaveBeenCalledExactlyOnceWith(confirmation);
    expect(deps.confirmDialog).toHaveBeenCalledBefore(client.buildAgentForkContext);
    expect(deps.archiveAgent).toHaveBeenCalledBefore(client.buildAgentForkContext);
    expect(paneContext.retargetCurrentTab).toHaveBeenCalledOnce();
    expect(workspaceAttachmentsStore.setWorkspaceAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({ attachment: expect.objectContaining({ text: finalText }) }),
        ],
      }),
    );
    expect(deps.archiveAgent).toHaveBeenCalledExactlyOnceWith({
      serverId: "host-1",
      agentId: "agent-1",
      expectedWorkspaceId: "workspace-1",
    });
  });

  it.each([
    "removed",
    "reply lost",
    "closed",
    "closed without history",
    "reopened",
    "replaced",
  ] as const)("handles an archive whose source is %s before the reply", async (change) => {
    const persisted = new Map<string, string>();
    const storage = {
      getItem: (key: string) => persisted.get(key) ?? null,
      setItem: (key: string, value: string) => {
        persisted.set(key, value);
      },
      removeItem: (key: string) => {
        persisted.delete(key);
      },
    };
    const layout = createWorkspaceLayoutStore(undefined, storage);
    await vi.waitFor(() => expect(layout.persist.hasHydrated()).toBe(true));
    const { client, deps, run, draftStore, workspaceAttachmentsStore, composerInput } =
      createHandoff();
    const sourceTarget = { kind: "agent", agentId: "agent-1" } as const;
    const replacement = { kind: "agent", agentId: "agent-2" } as const;
    const tabId = layout.getState().openTab({
      workspaceKey,
      target: sourceTarget,
      intent: "reveal",
    });
    if (!tabId) throw new Error("Expected a source tab");
    const retargetCurrentTab = vi.fn<NonNullable<Deps["paneContext"]>["retargetCurrentTab"]>(
      (target) => {
        layout.getState().replaceTab(workspaceKey, tabId, target);
      },
    );
    const queuedFile = {
      kind: "workspace_file",
      path: "queued.ts",
      selection: { kind: "whole_file" },
    } as const;
    deps.takeQueuedMessages.mockReturnValue({
      messages: [
        { id: "queued-1", text: "First queued prompt", attachments: [queuedFile] },
        { id: "queued-2", text: "Second queued prompt", attachments: [] },
      ],
      restore: vi.fn(() => true),
    });
    if (change === "closed without history") {
      client.buildAgentForkContext.mockRejectedValueOnce(new Error("History unavailable"));
    }

    deps.archiveAgent.mockImplementationOnce(async () => {
      if (change === "closed" || change === "closed without history" || change === "reopened") {
        layout.getState().closeTab(workspaceKey, tabId);
      }
      if (change === "reopened") {
        layout.getState().openTab({ workspaceKey, target: sourceTarget, intent: "reveal" });
      }
      if (change === "replaced") {
        layout.getState().replaceTab(workspaceKey, tabId, replacement);
      }
      // The active-directory removal and its reconciliation both precede the archive reply.
      deps.getAgent.mockReturnValue(null);
      deps.getComposerInput.mockReturnValue(null);
      draftStore.getDraftInput.mockReturnValue(undefined);
      const activeAgentIds = [];
      if (change === "replaced") activeAgentIds.push("agent-2");
      if (change === "reopened") activeAgentIds.push("agent-1");
      layout.getState().reconcileTabs(workspaceKey, {
        agentsHydrated: true,
        activeAgentIds,
        autoOpenAgentIds: [],
        terminalsHydrated: true,
        standaloneTerminalIds: [],
      });
      if (change === "removed" || change === "reply lost") {
        expect(layout.getState().getWorkspaceTabs(workspaceKey)[0]?.target).toEqual(sourceTarget);
      }
      if (change === "reply lost") {
        throw new DaemonConnectionError("Archive reply timed out", "DAEMON_REQUEST_TIMEOUT");
      }
    });
    deps.confirmSourceArchived.mockResolvedValueOnce(change === "reply lost");

    const switched = await run({
      paneContext: { ...deps.paneContext, tabId, retargetCurrentTab },
      getWorkspaceLayoutStore: layout.getState,
    });
    const shouldReplace = change === "removed" || change === "reply lost";
    expect(switched).toBe(true);
    expect(deps.confirmSourceArchived).toHaveBeenCalledTimes(Number(change === "reply lost"));
    if (!shouldReplace) {
      expect(retargetCurrentTab).not.toHaveBeenCalled();
      expect(
        layout
          .getState()
          .getWorkspaceTabs(workspaceKey)
          .map((tab) => tab.target)
          .filter((target) => target.kind === "agent" || target.kind === "draft"),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "draft", draftId: "draft-1" }),
          ...(change === "closed" || change === "closed without history"
            ? []
            : [change === "replaced" ? replacement : sourceTarget]),
        ]),
      );
    } else {
      expect(layout.getState().getWorkspaceTabs(workspaceKey)[0]?.target).toMatchObject({
        kind: "draft",
        draftId: "draft-1",
      });
    }
    expect(draftStore.saveDraftInput).toHaveBeenCalledExactlyOnceWith({
      draftKey: targetDraftKey,
      draft: {
        text: "First queued prompt\n\nSecond queued prompt\n\n  Continue here.  ",
        attachments: [queuedFile, ...composerInput.attachments],
      },
    });
    expect(workspaceAttachmentsStore.setWorkspaceAttachments).toHaveBeenCalledOnce();
    if (change === "closed without history" || change === "replaced") {
      const reopened = createWorkspaceLayoutStore(undefined, storage);
      await vi.waitFor(() => expect(reopened.persist.hasHydrated()).toBe(true));
      const tab = reopened
        .getState()
        .getWorkspaceTabs(workspaceKey)
        .find((entry) => entry.target.kind === "draft");
      if (tab?.target.kind !== "draft") throw new Error("Recovery draft was not persisted");
      reopened.getState().focusTab(workspaceKey, tab.tabId);
      expect(reopened.getState().focusRequest).toEqual({ workspaceKey, tabId: tab.tabId });
      expect(tab.target.setup?.restoreChatHistory).toBe(change !== "closed without history");
      expect(
        buildDraftStoreKey({ serverId: "host-1", agentId: tab.tabId, draftId: tab.target.draftId }),
      ).toBe(targetDraftKey);
    }
  });

  it("requires user prompt origin support only for handoffs that keep a parent", async () => {
    const parented = createHandoff({ parentAgentId: "parent-1" });
    parented.deps.supportsAgentInitialPromptOrigin.mockReturnValue(false);
    expect(await parented.run()).toBe(false);
    expect(parented.deps.toast.error).toHaveBeenCalledWith("message.actions.forkUnavailable");
    expect(parented.client.buildAgentForkContext).not.toHaveBeenCalled();
    expect(parented.client.updateAgent).not.toHaveBeenCalled();
    parented.expectSourceUntouched();

    const root = createHandoff();
    root.deps.supportsAgentInitialPromptOrigin.mockReturnValue(false);
    expect(await root.run()).toBe(true);
  });

  it("blocks a cross-host child even though its local parent field is empty", async () => {
    const { agent, client, paneContext, deps, run, expectSourceUntouched } = createHandoff({
      labels: parentAddressLabels({ serverId: "host-2", agentId: "remote-parent" }),
    });
    expect(
      canSwitchAgentProvider({
        serverId: "host-1",
        agent,
        client,
        paneContext,
        supportsAgentForkContext: true,
      }),
    ).toBe(false);
    expect(await run()).toBe(false);
    expect(deps.archiveAgent).not.toHaveBeenCalled();
    expect(client.updateAgent).not.toHaveBeenCalled();
    expectSourceUntouched();
  });

  it("asks before switching an attached child with a queue that stays with the old provider", async () => {
    const { client, deps, run } = createHandoff({ parentAgentId: "parent-1" });
    deps.hasQueuedMessages.mockReturnValue(true);
    deps.confirmDialog.mockResolvedValueOnce(false);
    expect(await run()).toBe(false);
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(await run()).toBe(true);
    expect(deps.confirmDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "workspace.tabs.confirmations.handoffKeepQueueMessage",
      }),
    );
    expect(deps.takeQueuedMessages).not.toHaveBeenCalled();
    expect(deps.archiveAgent).not.toHaveBeenCalled();
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
        restoreChatHistory: true,
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
      expectedWorkspaceId: "workspace-1",
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
      const { agent, client, deps, layoutStore, run, expectSourceUntouched } = createHandoff({
        parentAgentId: "parent-1",
      });
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

  it.each([
    { main: true, succeeds: true },
    { main: true, succeeds: false },
    { main: false, succeeds: true },
    { main: false, succeeds: false },
  ])(
    "keeps queued files across collection during handoff (main: $main, succeeds: $succeeds)",
    async ({ main, succeeds }) => {
      const path = main ? "main" : "ordinary";
      const image: AttachmentMetadata = {
        id: `image-${path}`,
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "queued",
        createdAt: 1,
      };
      const screenshot = { ...image, id: `screenshot-${path}` };
      const { deps, run, draftStore, workspaceAttachmentsStore } = createHandoff(
        main ? { labels: mainControlLabels } : {},
      );
      const { useDraftStore } =
        await vi.importActual<typeof import("@/stores/draft-store")>("@/stores/draft-store");
      await useDraftStore.getState().hydrateDraftInput({ draftKey: "other-draft" });
      const stored = new Set([image.id, screenshot.id, "orphan"]);
      const collectionStarted = Promise.withResolvers<void>();
      const finishCollection = Promise.withResolvers<void>();
      const garbageCollect = vi.fn(
        async ({ referencedIds }: { referencedIds: ReadonlySet<string> }) => {
          collectionStarted.resolve();
          await finishCollection.promise;
          for (const id of stored) if (!referencedIds.has(id)) stored.delete(id);
        },
      );
      const messages: ReturnType<Deps["takeQueuedMessages"]>["messages"] = [
        {
          id: "queued",
          text: "Queued",
          attachments: [
            { kind: "image", metadata: image },
            {
              kind: "browser_element",
              attachment: {
                screenshot,
                url: "https://example.com",
                selector: "main",
                tag: "main",
                text: "",
                outerHTML: "<main></main>",
                computedStyles: {},
                boundingRect: { x: 0, y: 0, width: 10, height: 10 },
                reactSource: null,
                parentChain: [],
                children: [],
                formatted: "main",
              },
            },
          ],
        },
      ];
      const expectRetained = () => {
        expect(collectRetainedAttachmentIds()).toEqual(new Set([image.id, screenshot.id]));
      };
      const restore = vi.fn(() => {
        expectRetained();
        return true;
      });
      deps.takeQueuedMessages.mockImplementationOnce((retain) => {
        retain(messages);
        expectRetained();
        return { messages, restore };
      });
      let queuedCollection: Promise<void> | undefined;
      const collectDuringHandoff = async () => {
        expectRetained();
        __setAttachmentStoreForTests({
          storageType: "web-indexeddb",
          save: vi.fn(),
          encodeBase64: vi.fn(),
          resolvePreviewUrl: vi.fn(),
          delete: vi.fn(),
          garbageCollect,
        });
        useDraftStore.getState().saveDraftInput({
          draftKey: "other-draft",
          draft: { text: "Triggers runAttachmentGc", attachments: [] },
        });
        await collectionStarted.promise;
        // Queue another pass with no references while the active pass is blocked.
        queuedCollection = garbageCollectAttachments({ referencedIds: new Set() });
        if (!succeeds) throw new Error("Switch refused");
      };
      const mainControlClient = createMainControlClient();
      if (main) {
        mainControlClient.setAgentMainControl.mockImplementationOnce(async () => {
          await collectDuringHandoff();
          return { enabled: true, workspaceId: "workspace-1", archivedSource: true };
        });
      } else {
        deps.archiveAgent.mockImplementationOnce(collectDuringHandoff);
      }
      if (succeeds) {
        draftStore.saveDraftInput.mockImplementationOnce(() => {
          expectRetained();
        });
      }
      try {
        expect(await run(main ? { mainControlClient } : {})).toBe(succeeds);
        expect(restore).toHaveBeenCalledTimes(succeeds ? 0 : 1);
        if (succeeds) {
          expect(draftStore.saveDraftInput).toHaveBeenCalledWith(
            expect.objectContaining({
              draft: expect.objectContaining({
                attachments: expect.arrayContaining([messages[0].attachments[0]]),
              }),
            }),
          );
          const workspaceWrite = main
            ? workspaceAttachmentsStore.addWorkspaceAttachment
            : workspaceAttachmentsStore.setWorkspaceAttachments;
          expect(workspaceWrite).toHaveBeenCalledWith(
            expect.objectContaining(
              main
                ? { attachment: messages[0].attachments[1] }
                : { attachments: expect.arrayContaining([messages[0].attachments[1]]) },
            ),
          );
        }
      } finally {
        finishCollection.resolve();
        await queuedCollection;
      }
      expect(garbageCollect.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [{ referencedIds }] of garbageCollect.mock.calls) {
        expect(referencedIds.has(image.id)).toBe(true);
        expect(referencedIds.has(screenshot.id)).toBe(true);
      }
      expect(stored).toEqual(new Set([image.id, screenshot.id]));
      expect(collectRetainedAttachmentIds()).toEqual(new Set());
      await garbageCollectAttachments({ referencedIds: new Set() });
      expect(stored).toEqual(new Set());
    },
  );

  it("leaves the source intact until archive succeeds and reports a failed archive", async () => {
    const { deps, run, expectSourceUntouched } = createHandoff();
    const archive = Promise.withResolvers<void>();
    const restore = vi.fn(() => true);
    deps.takeQueuedMessages.mockReturnValue({
      messages: [{ id: "queued", text: "Still waiting", attachments: [] }],
      restore,
    });
    deps.archiveAgent.mockReturnValueOnce(archive.promise);
    const handoff = run();
    await vi.waitFor(() => expect(deps.archiveAgent).toHaveBeenCalledOnce());
    expect(isHandoffInputLocked("host-1", "agent-1")).toBe(true);
    expectSourceUntouched();
    expect(restore).not.toHaveBeenCalled();
    archive.reject(new Error("Archive refused"));
    expect(await handoff).toBe(false);
    expect(isHandoffInputLocked("host-1", "agent-1")).toBe(false);
    expect(restore).toHaveBeenCalledOnce();
    expectSourceUntouched();
    expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith("Archive refused");
  });

  it("preserves the source and its queue when a message is still sending", async () => {
    const { deps, run, expectSourceUntouched } = createHandoff();
    deps.hasUnsettledMessage.mockReturnValue(true);

    expect(await run()).toBe(false);
    expect(deps.takeQueuedMessages).not.toHaveBeenCalled();
    expect(deps.archiveAgent).not.toHaveBeenCalled();
    expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith("composer.errors.alreadyLoading");
    expectSourceUntouched();
  });

  it("shares the lock with synchronous submit and attachment admission and releases it on a failed archive", async () => {
    const { deps, run } = createHandoff();
    const submit = beginComposerWork("host-1", "agent-1", "submit");
    expect(submit).toBeTypeOf("function");
    expect(beginComposerWork("host-1", "agent-1", "submit")).toBeNull();
    try {
      expect(await run()).toBe(false);
      expect(deps.archiveAgent).not.toHaveBeenCalled();
    } finally {
      submit?.();
    }

    const attachment = beginComposerWork("host-1", "agent-1", "attachment");
    expect(attachment).toBeTypeOf("function");
    try {
      expect(await run()).toBe(false);
      expect(deps.archiveAgent).not.toHaveBeenCalled();
    } finally {
      attachment?.();
    }

    deps.archiveAgent.mockImplementationOnce(async () => {
      expect(beginComposerWork("host-1", "agent-1", "submit")).toBeNull();
      expect(beginComposerWork("host-1", "agent-1", "attachment")).toBeNull();
      throw new Error("Archive refused");
    });
    expect(await run()).toBe(false);
    const retry = beginComposerWork("host-1", "agent-1", "submit");
    expect(retry).toBeTypeOf("function");
    retry?.();
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
    const { client, deps, run, expectSourceUntouched } = createHandoff({
      parentAgentId: "parent-1",
    });
    client.buildAgentForkContext.mockResolvedValueOnce({ ...forkPayload, attachment: null });

    expect(await run()).toBe(false);

    expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith("message.actions.forkFailed");
    expectSourceUntouched();
  });

  it("preserves the prompt and queued attachments if archived history is unavailable", async () => {
    const { client, deps, run, draftStore, paneContext, storedDraft } = createHandoff();
    const quote = { kind: "quote", id: "queued-quote", text: "Keep this" } as const;
    deps.takeQueuedMessages.mockReturnValue({
      messages: [{ id: "1", text: "Queued", attachments: [quote] }],
      restore: vi.fn(() => true),
    });
    client.buildAgentForkContext.mockRejectedValueOnce(new Error("Archived history unavailable"));
    expect(await run()).toBe(true);
    expect(draftStore.saveDraftInput).toHaveBeenCalledExactlyOnceWith({
      draftKey: targetDraftKey,
      draft: {
        text: "Queued\n\n  Continue here.  ",
        attachments: [quote, ...storedDraft.attachments],
      },
    });
    expect(paneContext.retargetCurrentTab).toHaveBeenCalledWith(
      expect.objectContaining({ setup: expect.objectContaining({ restoreChatHistory: false }) }),
    );
    expect(deps.toast.error).toHaveBeenCalledWith("Archived history unavailable");
  });

  it.each([null, true])(
    "recovers queued content when the runtime fails to close (archived: %s)",
    async (archived) => {
      const { deps, run, draftStore, layoutStore, paneContext, storedDraft } = createHandoff();
      const restore = vi.fn(() => true);
      deps.takeQueuedMessages.mockReturnValue({
        messages: [{ id: "1", text: "Queued", attachments: [] }],
        restore,
      });
      deps.archiveAgent.mockRejectedValueOnce(new Error("Runtime close failed"));
      deps.confirmSourceArchived.mockResolvedValueOnce(archived);
      expect(await run()).toBe(false);
      expect(restore).not.toHaveBeenCalled();
      expect(paneContext.retargetCurrentTab).not.toHaveBeenCalled();
      expect(layoutStore.openTab).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceKey, intent: "background" }),
      );
      expect(draftStore.saveDraftInput).toHaveBeenCalledWith({
        draftKey: targetDraftKey,
        draft: { text: "Queued\n\n  Continue here.  ", attachments: storedDraft.attachments },
      });
      expect(deps.toast.error).toHaveBeenCalledWith("Runtime close failed");
    },
  );

  it("migrates attachments-only drafts and skips draft persistence when prompt and metadata are empty", async () => {
    const { draftStore, composerInput, run } = createHandoff();
    composerInput.textSource.getSnapshot = () => "";
    draftStore.metadataByDraftKey = {};

    expect(await run()).toBe(true);

    expect(draftStore.saveDraftInput).toHaveBeenCalledExactlyOnceWith({
      draftKey: targetDraftKey,
      draft: { text: "", attachments: composerInput.attachments },
    });
    expect(draftStore.patchDraftMetadata).not.toHaveBeenCalled();

    const emptyHandoff = createHandoff();
    emptyHandoff.composerInput.textSource.getSnapshot = () => "";
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
    expect(await run({ inFlight })).toBe(true);
    expect(inFlight.current).toBe(false);
  });
});

describe("canSwitchAgentProvider", () => {
  it("requires agentForkContext support, a connected client, and a non-sheet workspace pane", () => {
    const { agent, client, paneContext } = createHandoff();
    const input = {
      serverId: "host-1",
      supportsAgentForkContext: true,
      client,
      paneContext,
      agent,
    };
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
    expect(
      canSwitchAgentProvider({
        ...input,
        supportsAgentHierarchyControl: true,
        agent: { labels: mainControlLabels },
      }),
    ).toBe(true);
  });
});
