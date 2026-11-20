/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore } from "@/stores/session-store";
import { normalizeWorkspaceDraftTabSetup } from "@/workspace-tabs/identity";
import { buildNewAgentTabTarget } from "@/workspace-tabs/new-tab";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import {
  buildMainSubagentTabDraftSetup,
  buildSubagentDraftSetup,
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
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-form-preferences", () => ({
  useFormPreferences: () => ({ preferences: { provider: "pi" } }),
}));
vi.mock("@/hooks/use-settings", () => ({ useSettings: vi.fn() }));
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
        const draftId = await prepareForkDraft({ ...input, quoteText: "Selected text" });
        const seed = getQuoteDraft(draftId);
        expect(seed?.attachments).toHaveLength(1);

        const edit = { text: "Keep my draft", attachments: [] };
        if (editLocation === "live") {
          useDraftStore
            .getState()
            .editDraftText({ draftKey: getDraftKey(draftId), text: edit.text });
        }
        if (editLocation === "cleared") {
          useDraftStore.getState().clearDraftInput({
            draftKey: getDraftKey(draftId),
            lifecycle: "abandoned",
          });
        }
        const drafts =
          editLocation === "persisted" || editLocation === "abandoned"
            ? {
                ...draftsBefore,
                [getDraftKey(draftId)]: {
                  input: editLocation === "persisted" ? edit : { text: "", attachments: [] },
                  lifecycle:
                    editLocation === "persisted" ? ("active" as const) : ("abandoned" as const),
                  updatedAt: Date.now(),
                  version: 1,
                },
              }
            : draftsBefore;
        finishRead({ state: { drafts, createModalDraft: null }, version });
        await hydration;

        expect(getQuoteDraft(draftId)).toEqual(
          {
            none: seed,
            persisted: edit,
            live: { ...seed, text: edit.text },
            abandoned: undefined,
            cleared: undefined,
          }[editLocation],
        );
        if (editLocation === "cleared") {
          expect(useDraftStore.getState().drafts[getDraftKey(draftId)]?.lifecycle).toBe(
            "abandoned",
          );
        }
      } finally {
        finishRead({ state: { drafts: draftsBefore, createModalDraft: null }, version });
        await hydration;
        read.mockRestore();
      }
    },
  );
});
