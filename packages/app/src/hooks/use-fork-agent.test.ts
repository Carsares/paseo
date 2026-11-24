/** @vitest-environment jsdom */
import { useRouter } from "expo-router";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  EXPLICIT_PARENT_REPORTING,
  MAIN_PRIOR_MODE_ID_LABEL,
  PARENT_AGENT_ID_LABEL,
  PARENT_REPORTING_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import * as draftKeys from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { normalizeWorkspaceDraftTabSetup } from "@/workspace-tabs/identity";
import { buildNewAgentTabTarget } from "@/workspace-tabs/new-tab";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import {
  appendSideChatReplyToDraft,
  buildMainSubagentTabDraftSetup,
  buildSideChatDraftSetup,
  buildSubagentDraftSetup,
  type ForkAgentRequest,
  prepareForkDraft,
  useForkAgent,
} from "./use-fork-agent";

await vi.hoisted(async () => {
  const { IDBKeyRange, indexedDB } = await import("fake-indexeddb");
  Object.assign(globalThis, { IDBKeyRange, indexedDB });
});

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: async (key: string) => storage.get(key) ?? null,
      setItem: async (key: string, value: string) => void storage.set(key, value),
      removeItem: async (key: string) => void storage.delete(key),
    },
  };
});
vi.mock("expo-router", () => ({ useRouter: vi.fn() }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/use-form-preferences", () => ({
  useFormPreferences: () => ({ preferences: { provider: "pi" } }),
}));
const { acceptAgentSnapshot, push, openInSidePane } = vi.hoisted(() => ({
  acceptAgentSnapshot: vi.fn(),
  push: vi.fn<(href: string) => void>(),
  openInSidePane: { subagents: true },
}));
vi.mock("@/hooks/use-settings", () => ({ useSettings: () => openInSidePane }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ acceptAgentSnapshot }),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({ navigateToWorkspace: vi.fn() }));
vi.mock("@/workspace-tabs/open-beside", () => ({ openPreferredWorkspaceTarget: vi.fn() }));

const mainAgent = {
  provider: "custom-provider",
  cwd: "/workspace/project",
  currentModeId: "read-only",
  model: "coordinator-model",
  thinkingOptionId: "high",
  options: { customPermissionPolicy: "deny" },
  labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
};

describe("drafts from Main Control", () => {
  it.each(["pi", undefined])(
    "keeps the parent and leaves coding defaults to the composer (%s)",
    (preferredProvider) => {
      const setup = buildSubagentDraftSetup(mainAgent, "main-1", preferredProvider);

      expect(normalizeWorkspaceDraftTabSetup(setup)).toMatchObject({
        parentAgentId: "main-1",
        provider: preferredProvider ?? mainAgent.provider,
        cwd: mainAgent.cwd,
        modeId: null,
        model: null,
        thinkingOptionId: null,
        providerOptions: {},
      });
    },
  );

  it.each([
    {
      modeId: "read-only",
      priorMode: "full-access",
      inheritedMode: "full-access",
      preferredProvider: "codex",
    },
    {
      modeId: "workspace-write",
      priorMode: "full-access",
      inheritedMode: "workspace-write",
      preferredProvider: undefined,
    },
    {
      modeId: "read-only",
      priorMode: null,
      inheritedMode: "read-only",
      preferredProvider: undefined,
    },
  ])(
    "inherits $inheritedMode from Main Control with current mode $modeId",
    ({ modeId, priorMode, inheritedMode, preferredProvider }) => {
      const options = {
        sandbox_mode: "read-only",
        approval_policy: "never",
        service_tier: "priority",
      };
      const setup = buildSubagentDraftSetup(
        {
          ...mainAgent,
          provider: "codex",
          currentModeId: modeId,
          options,
          labels: {
            ...mainAgent.labels,
            ...(priorMode ? { [MAIN_PRIOR_MODE_ID_LABEL]: priorMode } : {}),
          },
        },
        "main-1",
        preferredProvider,
      );
      expect(setup?.modeId).toBe(inheritedMode);
      expect(setup?.providerOptions).toEqual(options);
    },
  );

  it.each(["codex", "claude"])(
    "prefers the configured %s options when an older host provides them",
    (provider) => {
      const options =
        provider === "codex"
          ? { sandbox_mode: "read-only", approval_policy: "never" }
          : { disallowedTools: ["WebFetch", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"] };
      const subagentDraftOptions =
        provider === "codex" ? { approval_policy: "on-request" } : { disallowedTools: ["Bash"] };
      const setup = buildSubagentDraftSetup(
        { ...mainAgent, provider, options, subagentDraftOptions },
        "main-1",
      );
      expect(setup?.providerOptions).toEqual(subagentDraftOptions);
    },
  );

  it("gives the button and keyboard shortcut the same parent, while standalone opens a root draft", () => {
    const resolveSubagentSetup = () =>
      buildMainSubagentTabDraftSetup({ mainAgent, mainAgentId: "main-1", preferredProvider: "pi" });
    const draftId = "draft-1";
    const shortcut = buildNewAgentTabTarget({ draftId, resolveSubagentSetup });
    const button = buildNewAgentTabTarget({
      draftId,
      selection: { kind: "agent" },
      resolveSubagentSetup,
    });
    const standalone = buildNewAgentTabTarget({
      draftId,
      selection: { kind: "agent", relationship: "standalone" },
      resolveSubagentSetup,
    });

    expect(shortcut.setup).toMatchObject({ parentAgentId: "main-1", provider: "pi" });
    expect(button).toEqual(shortcut);
    expect(standalone).toEqual({ kind: "draft", draftId });
  });
});

const subagent = {
  provider: "codex",
  cwd: "/workspace/project",
  currentModeId: "workspace-write",
  model: "subagent-model",
  thinkingOptionId: "high",
  options: { approval_policy: "on-request" },
};
const sharedParentId = "main-1";

describe("drafts from a subagent", () => {
  it("inherits the source settings and shares its parent", () => {
    expect(buildSubagentDraftSetup(subagent, sharedParentId, "pi")).toEqual({
      provider: "codex",
      cwd: "/workspace/project",
      parentAgentId: sharedParentId,
      modeId: "workspace-write",
      model: "subagent-model",
      thinkingOptionId: "high",
      providerOptions: { approval_policy: "on-request" },
    });
  });
});

describe("seamless timeline forks", () => {
  const serverId = "seamless-host";
  const workspaceId = "workspace-1";
  const workspaceKey = `${serverId}:${workspaceId}`;
  const boundary = { boundaryMessageId: "message-1", boundaryCursor: { epoch: "old", seq: 5 } };
  const forkFrom = { sourceAgentId: "source-agent", ...boundary };
  const request = {
    agentId: forkFrom.sourceAgentId,
    agent: subagent,
    workspaceId,
    boundary,
  };
  const config = {
    provider: "codex",
    cwd: "/workspace/project",
    modeId: "workspace-write",
    model: "subagent-model",
    thinkingOptionId: "high",
    providerOptions: { approval_policy: "on-request" },
  };

  it("freezes the displayed timeline boundary and puts the question in draft text", () => {
    const timeline = {
      status: "synced",
      items: [],
      range: { epoch: "timeline", startSeq: 1, endSeq: 9 },
      older: "none",
      newer: "none",
    } as const;
    const liveCursor = { epoch: "timeline", seq: 10 };
    const setup = buildSideChatDraftSetup({
      agentId: "main",
      agent: subagent,
      timeline: { ...timeline, items: [] },
      liveItems: [
        {
          kind: "assistant_message",
          id: "visible",
          timestamp: new Date(),
          text: "Visible answer",
          timelineCursor: liveCursor,
        },
      ],
      text: "why?  \n",
    });
    expect(setup).toMatchObject({
      sideChatFromAgentId: "main",
      forkFrom: { sourceAgentId: "main", boundaryCursor: { epoch: "timeline", seq: 10 } },
      initialDraftText: "why?  \n",
    });
    expect(setup).not.toHaveProperty("parentAgentId");
    expect(
      buildSideChatDraftSetup({ agentId: "main", agent: subagent, timeline: { status: "cold" } }),
    ).toBeUndefined();
    expect(
      buildSideChatDraftSetup({
        agentId: "main",
        agent: subagent,
        timeline: { ...timeline, items: [], range: null },
      }),
    ).toMatchObject({
      sideChatFromAgentId: "main",
      forkFrom: { sourceAgentId: "main", boundaryCursor: { epoch: "", seq: 0 } },
    });
  });

  async function fork(
    input: ForkAgentRequest,
    run: (input: {
      onFork: (request: ForkAgentRequest) => Promise<void>;
      createAgent: ReturnType<typeof vi.fn<DaemonClient["createAgent"]>>;
      toast: NonNullable<Parameters<typeof useForkAgent>[0]["toast"]>;
    }) => Promise<void> = ({ onFork }) => onFork(input),
  ) {
    const created: AgentSnapshotPayload = {
      id: `created-${input.target}`,
      provider: "codex",
      model: "subagent-model",
      cwd: "/workspace/project",
      workspaceId,
      status: "idle",
      createdAt: "2026-11-21T00:00:00Z",
      updatedAt: "2026-11-21T00:00:00Z",
      lastUserMessageAt: null,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: input.parentAgentId ? { [PARENT_AGENT_ID_LABEL]: input.parentAgentId.trim() } : {},
    };
    const createAgent = vi.fn<DaemonClient["createAgent"]>().mockResolvedValue(created);
    const buildAgentForkContext = vi.fn<DaemonClient["buildAgentForkContext"]>();
    const session = useSessionStore.getState();
    session.initializeSession(serverId, {
      createAgent,
      buildAgentForkContext,
    } as unknown as DaemonClient);
    session.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: null,
      features: { agentSeamlessContextSwitch: true, agentHierarchyControl: true },
    });
    vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<typeof useRouter>);
    acceptAgentSnapshot.mockClear();
    vi.mocked(navigateToWorkspace).mockReset();
    const attachmentsBefore = useWorkspaceAttachmentsStore.getState().attachmentsByScope;
    const toast = { error: vi.fn() } as unknown as NonNullable<
      Parameters<typeof useForkAgent>[0]["toast"]
    >;
    const { result, unmount } = renderHook(() => useForkAgent({ serverId, toast }));
    try {
      await run({ onFork: result.current, createAgent, toast });
    } finally {
      unmount();
      session.clearSession(serverId);
    }
    expect(buildAgentForkContext).not.toHaveBeenCalled();
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).toBe(attachmentsBefore);
    return { createAgent, created, toast };
  }

  function assertSeededTabQuote() {
    const draftKey = draftKeys.buildDraftStoreKey({ serverId, agentId: "created-tab" });
    expect(acceptAgentSnapshot).toHaveBeenCalledTimes(1);
    expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({
      text: "",
      attachments: [{ kind: "quote", id: expect.any(String), text: "Selected for tab" }],
    });
    return "/workspace";
  }

  it("opens the real fork as a new tab before the user sends any prompt", async () => {
    const input = { ...request, target: "tab", quoteText: "Selected for tab" } as const;
    const { createAgent, created, toast } = await fork(input, async ({ onFork }) => {
      vi.mocked(navigateToWorkspace).mockImplementationOnce(assertSeededTabQuote);
      await onFork(input);
    });

    expect(toast.error).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledExactlyOnceWith({ config, workspaceId, forkFrom });
    expect(acceptAgentSnapshot).toHaveBeenCalledExactlyOnceWith(
      serverId,
      expect.objectContaining({ id: created.id, workspaceId, status: "idle" }),
    );
    expect(navigateToWorkspace).toHaveBeenCalledExactlyOnceWith({
      serverId,
      workspaceId,
      target: { kind: "agent", agentId: created.id },
      asTab: true,
    });
  });

  it("ignores duplicate clicks and releases the fork after reporting a create failure", async () => {
    const input = { ...request, target: "tab", boundary: undefined } as const;
    const outcome = await fork(input, async ({ onFork, createAgent, toast }) => {
      const attempt = Promise.withResolvers<AgentSnapshotPayload>();
      createAgent.mockReturnValueOnce(attempt.promise);
      const first = onFork(input);
      await onFork({ ...input, target: "subagent" });
      expect(createAgent).toHaveBeenCalledTimes(1);

      attempt.reject(new Error("Creation failed"));
      await first;
      expect(toast.error).toHaveBeenCalledExactlyOnceWith("Creation failed");
      expect(navigateToWorkspace).not.toHaveBeenCalled();
      expect(acceptAgentSnapshot).not.toHaveBeenCalled();

      await onFork(input);
    });
    expect(outcome.createAgent).toHaveBeenCalledTimes(2);
    expect(outcome.createAgent).toHaveBeenLastCalledWith({
      config,
      workspaceId,
      forkFrom: { sourceAgentId: request.agentId },
    });
    expect(navigateToWorkspace).toHaveBeenCalledTimes(1);
    expect(outcome.toast.error).toHaveBeenCalledTimes(1);
  });

  it("seeds only the selected quote before opening a sibling in the compact sheet", async () => {
    const target = { kind: "agent", agentId: "created-subagent" } as const;
    const draftKey = draftKeys.buildDraftStoreKey({ serverId, agentId: target.agentId });
    const { openPreferredWorkspaceTarget: openActual } = await vi.importActual<
      typeof import("@/workspace-tabs/open-beside")
    >("@/workspace-tabs/open-beside");
    const layout = useWorkspaceLayoutStore.getState();
    layout.setLayoutMode("compact");
    acceptAgentSnapshot.mockImplementationOnce((id, agent) => {
      useSessionStore.getState().setAgents(id, new Map([[agent.id, agent]]));
    });
    const open = vi.mocked(openPreferredWorkspaceTarget).mockReset();
    open.mockImplementationOnce((destination) => {
      expect(acceptAgentSnapshot).toHaveBeenCalledTimes(1);
      expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({
        text: "",
        attachments: [{ kind: "quote", id: expect.any(String), text: "Selected text" }],
      });
      return openActual(destination);
    });
    try {
      const { createAgent, toast } = await fork({
        ...request,
        target: "subagent",
        parentAgentId: ` ${sharedParentId} `,
        parentTabId: "source-tab",
        quoteText: "\nSelected text\n",
      });

      expect(toast.error).not.toHaveBeenCalled();
      expect(createAgent).toHaveBeenCalledExactlyOnceWith({
        config,
        workspaceId,
        forkFrom,
        callerAgentId: sharedParentId,
        initialPromptOrigin: "user",
        labels: {
          [PARENT_AGENT_ID_LABEL]: sharedParentId,
          [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING,
        },
      });
      expect(open).toHaveBeenCalledExactlyOnceWith({
        workspaceKey,
        target,
        preferences: openInSidePane,
        source: "subagents",
        parentTabId: "source-tab",
      });
      expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[workspaceKey]).toMatchObject([
        { tab: { target }, parentTabId: "source-tab" },
      ]);
      expect(navigateToWorkspace).not.toHaveBeenCalled();
    } finally {
      layout.setLayoutMode(layout.layoutMode);
      useWorkspaceLayoutStore.setState({ sheetsByWorkspace: layout.sheetsByWorkspace });
    }
  });

  it("keeps the boundary and quote in the new workspace draft until submission", async () => {
    push.mockClear();
    const { createAgent, toast } = await fork({
      ...request,
      target: "workspace",
      quoteText: "Selected",
    });

    expect(toast.error).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
    const [href] = push.mock.calls[0];
    const route = new URL(href, "https://paseo.test");
    expect(route.pathname).toBe("/new");
    expect(route.searchParams.get("serverId")).toBe(serverId);
    const draftId = route.searchParams.get("draftId");
    if (!draftId) throw new Error("Expected a new workspace draft ID");
    const pending = useWorkspaceDraftSubmissionStore.getState().setupByDraftId[draftId];
    expect(pending).toEqual({ sourceDirectory: subagent.cwd, setup: { ...config, forkFrom } });
    expect(
      useDraftStore.getState().getDraftInput(draftKeys.buildNewWorkspaceDraftKey(draftId)),
    ).toEqual({
      text: "",
      attachments: [{ kind: "quote", id: expect.any(String), text: "Selected" }],
    });
  });
});

describe("fork draft attachments", () => {
  const agentId = "subagent-1";
  const serverId = "host-1";
  const boundary = { boundaryMessageId: "message-1" };
  const payload = {
    requestId: "fork-1",
    agentId,
    attachment: {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
      text: "Earlier context",
    },
    itemCount: 1,
    boundaryMessageId: boundary.boundaryMessageId,
    error: null,
  } as const;
  const client = { buildAgentForkContext: async () => payload };
  const input = { client, serverId, agentId, boundary, missingAttachmentMessage: "No history" };
  const getDraftKey = (draftId: string) => `draft:${serverId}:${draftId}`;
  const getQuoteDraft = (draftId: string) =>
    useDraftStore.getState().getDraftInput(getDraftKey(draftId));

  it("appends the side reply to the original draft while keeping its text and other quotes", async () => {
    const draftKey = draftKeys.buildDraftStoreKey({ serverId, agentId: "side-chat-main" });
    await useDraftStore.getState().hydrateDraftInput({ draftKey });
    const existing = { kind: "quote", id: "existing", text: "Keep my quote" } as const;
    const text = "Keep my draft  \n";
    useDraftStore.getState().saveDraftInput({ draftKey, draft: { text, attachments: [existing] } });
    await expect(
      appendSideChatReplyToDraft({
        draftKey,
        text: "Side answer",
        canQuote: () => true,
      }),
    ).resolves.toBe(true);
    await expect(
      appendSideChatReplyToDraft({
        draftKey,
        text: "Unavailable source",
        canQuote: () => false,
      }),
    ).resolves.toBe(false);
    expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({
      text,
      attachments: [
        existing,
        {
          kind: "quote",
          id: expect.any(String),
          text: "Side answer",
        },
      ],
    });
  });

  it.each([
    {
      relationship: "a child of a regular session",
      sourceAgentId: "root-1",
      sourceAgent: subagent,
      parentAgentId: null,
      expectedSetup: { provider: "codex", modeId: "workspace-write", parentAgentId: "root-1" },
    },
    {
      relationship: "a child of Main Control",
      sourceAgentId: sharedParentId,
      sourceAgent: mainAgent,
      parentAgentId: "  ",
      expectedSetup: {
        provider: "pi",
        modeId: null,
        model: null,
        thinkingOptionId: null,
        providerOptions: {},
        parentAgentId: sharedParentId,
      },
    },
    {
      relationship: "a sibling of a subagent",
      sourceAgentId: agentId,
      sourceAgent: subagent,
      parentAgentId: ` ${sharedParentId} `,
      expectedSetup: {
        provider: "codex",
        cwd: "/workspace/project",
        parentAgentId: sharedParentId,
        modeId: "workspace-write",
        model: "subagent-model",
        thinkingOptionId: "high",
        providerOptions: { approval_policy: "on-request" },
      },
    },
  ])(
    "opens $relationship with chat history and the selected quote",
    async ({ sourceAgentId, sourceAgent, parentAgentId, expectedSetup }) => {
      const buildAgentForkContext = vi.fn(async () => ({ ...payload, agentId: sourceAgentId }));
      const session = useSessionStore.getState();
      session.initializeSession(serverId, { buildAgentForkContext } as unknown as DaemonClient);
      session.updateSessionServerInfo(serverId, {
        serverId,
        hostname: null,
        version: null,
        features: { agentForkContext: true, agentHierarchyControl: true },
      });
      const openDraft = vi.mocked(openPreferredWorkspaceTarget).mockReset();
      openDraft.mockReturnValueOnce("fork-tab");
      const { result, unmount } = renderHook(() => useForkAgent({ serverId }));
      try {
        await result.current({
          agentId: sourceAgentId,
          agent: sourceAgent,
          workspaceId: "workspace-1",
          parentAgentId,
          target: "subagent",
          boundary,
          quoteText: "\nSelected text\n",
        });
      } finally {
        unmount();
        session.clearSession(serverId);
      }

      expect(buildAgentForkContext).toHaveBeenCalledExactlyOnceWith(sourceAgentId, boundary);
      const target = openDraft.mock.lastCall?.[0].target;
      if (target?.kind !== "draft") throw new Error("Expected an opened draft tab");
      expect(target.setup).toMatchObject(expectedSetup);
      const { draftId } = target;
      const scopeKey = buildDraftWorkspaceAttachmentScopeKey(draftId);
      expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey]).toMatchObject([
        {
          kind: "chat_history",
          attachment: { text: "Earlier context" },
          source: { agentId: sourceAgentId, boundaryMessageId: "message-1" },
        },
      ]);
      expect(getQuoteDraft(draftId)).toEqual({
        text: "",
        attachments: [{ kind: "quote", id: expect.any(String), text: "Selected text" }],
      });
    },
  );

  it("does not create a quote draft for whitespace alone", async () => {
    const draftId = await prepareForkDraft({ ...input, quoteText: " \t\n " });

    expect(getQuoteDraft(draftId)).toBeUndefined();
  });

  it("leaves both stores untouched when building chat history fails", async () => {
    const draftsBefore = useDraftStore.getState().drafts;
    const attachmentsBefore = useWorkspaceAttachmentsStore.getState().attachmentsByScope;
    const failingClient = {
      buildAgentForkContext: async () => {
        throw new Error("Fork context unavailable");
      },
    };

    await expect(
      prepareForkDraft({ ...input, client: failingClient, quoteText: "Selected text" }),
    ).rejects.toThrow("Fork context unavailable");
    expect(useDraftStore.getState().drafts).toBe(draftsBefore);
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).toBe(attachmentsBefore);
  });

  it.each(["none", "persisted", "live", "abandoned", "cleared"] as const)(
    "preserves the correct draft after hydration (edit: %s)",
    async (editLocation) => {
      const draftId = `pending-fork-${editLocation}`;
      const draftKey = getDraftKey(draftId);
      const generate = vi.spyOn(draftKeys, "generateDraftId").mockReturnValueOnce(draftId);
      const edit = { text: "Keep my draft", attachments: [] };
      if (editLocation === "cleared") {
        useDraftStore.getState().saveDraftInput({ draftKey, draft: edit });
      }
      const { storage, version } = useDraftStore.persist.getOptions();
      if (!storage) throw new Error("Draft persistence storage is unavailable");
      type StoredDrafts = Pick<
        ReturnType<typeof useDraftStore.getState>,
        "drafts" | "createModalDraft"
      >;
      let finishRead!: (value: { state: StoredDrafts; version?: number }) => void;
      const pendingRead = new Promise<Parameters<typeof finishRead>[0]>((resolve) => {
        finishRead = resolve;
      });
      const read = vi.spyOn(storage, "getItem").mockReturnValueOnce(pendingRead);
      const hydration = useDraftStore.persist.rehydrate();
      const draftsBefore = useDraftStore.getState().drafts;

      try {
        const fork = prepareForkDraft({ ...input, quoteText: "Selected text" });
        if (editLocation === "live") {
          useDraftStore.getState().editDraftText({ draftKey, text: edit.text });
        }
        if (editLocation === "cleared") {
          useDraftStore.getState().clearDraftInput({
            draftKey,
            lifecycle: "abandoned",
          });
        }
        const drafts =
          editLocation === "persisted" || editLocation === "abandoned"
            ? {
                ...draftsBefore,
                [draftKey]: {
                  input: editLocation === "persisted" ? edit : { text: "", attachments: [] },
                  lifecycle:
                    editLocation === "persisted" ? ("active" as const) : ("abandoned" as const),
                  updatedAt: Date.now(),
                  version: 1,
                },
              }
            : draftsBefore;
        finishRead({ state: { drafts, createModalDraft: null }, version });
        await expect(fork).resolves.toBe(draftId);

        expect(getQuoteDraft(draftId)).toEqual(
          {
            none: {
              text: "",
              attachments: [{ kind: "quote", id: expect.any(String), text: "Selected text" }],
            },
            persisted: edit,
            live: edit,
            abandoned: undefined,
            cleared: undefined,
          }[editLocation],
        );
        if (editLocation === "cleared") {
          expect(useDraftStore.getState().drafts[draftKey]?.lifecycle).toBe("abandoned");
        }
      } finally {
        finishRead({ state: { drafts: draftsBefore, createModalDraft: null }, version });
        await hydration;
        read.mockRestore();
        generate.mockRestore();
      }
    },
  );
});
