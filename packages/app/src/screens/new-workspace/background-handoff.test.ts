import { beforeEach, describe, expect, it } from "vitest";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { flushDraftPersistStorage, useDraftStore } from "@/stores/draft-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import {
  captureWorkspaceDraftCleanup,
  captureWorkspaceDraftCleanupOwner,
  clearOwnedWorkspaceDraft,
  createWorkspaceAgentInBackground,
  saveWorkspaceDraftCleanupOwner,
} from "./background-handoff";

const DRAFT_ID = "draft_1";
const DRAFT_KEY = "new-workspace";
const SCOPE_KEY = "draft:draft_1";

function saveDraft(text: string) {
  useDraftStore
    .getState()
    .saveDraftInput({ draftKey: DRAFT_KEY, draft: { text, attachments: [] } });
}

function draftText(): string | undefined {
  return useDraftStore.getState().drafts[DRAFT_KEY]?.input.text;
}

function captureCleanup() {
  return captureWorkspaceDraftCleanup({
    draftId: DRAFT_ID,
    draftKey: DRAFT_KEY,
    clearDraft: (lifecycle) =>
      useDraftStore.getState().clearDraftInput({ draftKey: DRAFT_KEY, lifecycle }),
    draftContextScopeKey: SCOPE_KEY,
  });
}

function run(createAgent: () => Promise<unknown>, clearConsumedDraft = captureCleanup()) {
  return createWorkspaceAgentInBackground({ createAgent, clearConsumedDraft });
}

beforeEach(() => {
  useWorkspaceDraftSubmissionStore.setState({ pendingByDraftId: {}, setupByDraftId: {} });
  useCreateFlowStore.setState({ pendingByDraftId: {} });
  useWorkspaceAttachmentsStore.setState({ attachmentsByScope: { [SCOPE_KEY]: [] } });
  saveDraft("do the thing");
});

describe("createWorkspaceAgentInBackground", () => {
  it("preserves context added to a newer draft without editing its text", async () => {
    await run(async () => {
      useWorkspaceAttachmentsStore.getState().addWorkspaceAttachment({
        scopeKey: SCOPE_KEY,
        attachment: {
          kind: "chat_history",
          id: "fork-context",
          attachment: {
            type: "text",
            mimeType: "text/plain",
            contextKind: "chat_history",
            title: "Chat history",
            text: "Preserve this context",
          },
          source: { serverId: "local", agentId: "agent-1" },
        },
      });
      useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
        draftId: DRAFT_ID,
        setup: {
          cwd: "/work/new-repo",
          provider: "codex",
          modeId: null,
          model: null,
          thinkingOptionId: null,
          providerOptions: {},
        },
      });
    });
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[SCOPE_KEY]).toHaveLength(1);
    expect(useWorkspaceDraftSubmissionStore.getState().setupByDraftId[DRAFT_ID]?.setup.cwd).toBe(
      "/work/new-repo",
    );
  });

  it("creates one agent and clears the consumed draft setup, attachments and input", async () => {
    let calls = 0;
    useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
      draftId: DRAFT_ID,
      setup: {
        cwd: "/work/repo",
        provider: "claude",
        modeId: null,
        model: null,
        thinkingOptionId: null,
        providerOptions: {},
      },
    });

    await run(async () => {
      calls += 1;
    });

    expect(calls).toBe(1);
    expect(useWorkspaceDraftSubmissionStore.getState().setupByDraftId).toEqual({});
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[SCOPE_KEY]).toBeUndefined();
    expect(draftText()).toBe("");
  });

  it("preserves context changed while workspace creation was pending", async () => {
    const clearConsumedDraft = captureCleanup();
    useWorkspaceAttachmentsStore.getState().addWorkspaceAttachment({
      scopeKey: SCOPE_KEY,
      attachment: {
        kind: "chat_history",
        id: "fork-context",
        attachment: {
          type: "text",
          mimeType: "text/plain",
          contextKind: "chat_history",
          title: "Chat history",
          text: "Preserve this context",
        },
        source: { serverId: "local", agentId: "agent-1" },
      },
    });
    await run(async () => undefined, clearConsumedDraft);
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[SCOPE_KEY]).toHaveLength(1);
    expect(draftText()).toBe("do the thing");
  });

  it("leaves no pending submission behind, so no draft tab can create a second agent", async () => {
    await run(async () => undefined);

    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).toEqual({});
    expect(useCreateFlowStore.getState().pendingByDraftId).toEqual({});
  });

  it("rethrows a failed creation and keeps the prompt for retry", async () => {
    const failure = new Error("daemon exploded");

    await expect(
      run(async () => {
        throw failure;
      }),
    ).rejects.toThrow(failure);

    expect(draftText()).toBe("do the thing");
  });

  it("keeps a prompt typed into the shared draft while creation was in flight", async () => {
    await run(async () => {
      saveDraft("a different idea");
    });

    expect(draftText()).toBe("a different idea");
  });
  it("keeps a newer draft written while workspace creation was pending", async () => {
    useWorkspaceAttachmentsStore.getState().addWorkspaceAttachment({
      scopeKey: SCOPE_KEY,
      attachment: {
        kind: "chat_history",
        id: "fork-context",
        attachment: {
          type: "text",
          mimeType: "text/plain",
          contextKind: "chat_history",
          title: "Chat history",
          text: "Preserve this context",
        },
        source: { serverId: "local", agentId: "agent-1" },
      },
    });
    const clearConsumedDraft = captureCleanup();
    saveDraft("a newer workspace idea");
    await run(async () => undefined, clearConsumedDraft);
    expect(draftText()).toBe("a newer workspace idea");
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[SCOPE_KEY]).toHaveLength(1);
  });
});

describe("persisted workspace draft ownership", () => {
  it.each(["unchanged", "typed", "attachment", "legacy", "other-window"] as const)(
    "only clears the draft owned by the original submission (%s)",
    async (edit) => {
      const store = useWorkspaceDraftSubmissionStore.getState();
      const id = await store.openDraftTitle({ createWorktreeSlug: () => "workspace" });
      const cleanup = {
        draftId: id,
        draftKey: DRAFT_KEY,
        draftContextScopeKey: SCOPE_KEY,
        clearDraft: (lifecycle: "sent" | "abandoned") =>
          useDraftStore.getState().clearDraftInput({ draftKey: DRAFT_KEY, lifecycle }),
      };
      try {
        await useWorkspaceAttachmentsStore.hydration;
        if (!useDraftStore.persist.hasHydrated()) await useDraftStore.persist.rehydrate();
        saveDraft("Original prompt");
        const owner = captureWorkspaceDraftCleanupOwner(cleanup);
        if (edit !== "legacy") await saveWorkspaceDraftCleanupOwner(id, owner);
        if (edit === "typed") saveDraft("Next prompt from another page");
        if (edit === "attachment") {
          useWorkspaceAttachmentsStore.getState().addWorkspaceAttachment({
            scopeKey: SCOPE_KEY,
            attachment: {
              kind: "chat_history",
              id: "new-history",
              attachment: {
                type: "text",
                mimeType: "text/plain",
                contextKind: "chat_history",
                text: "New attachment",
                title: "New history",
              },
              source: { serverId: "local", agentId: "agent-1" },
            },
          });
        }
        await flushDraftPersistStorage();
        if (edit === "other-window") {
          const { name, storage } = useDraftStore.persist.getOptions();
          const stored = await storage!.getItem(name!);
          const record = useDraftStore.getState().drafts[DRAFT_KEY]!;
          await storage!.setItem(name!, {
            ...stored,
            state: {
              ...stored?.state,
              drafts: {
                ...stored?.state.drafts,
                [DRAFT_KEY]: {
                  ...record,
                  input: { ...record.input, text: "From another window" },
                  version: record.version + 1,
                },
              },
            },
          });
          await flushDraftPersistStorage();
        }
        await clearOwnedWorkspaceDraft(id, cleanup);
        const expected = {
          unchanged: "",
          typed: "Next prompt from another page",
          attachment: "Original prompt",
          legacy: "Original prompt",
          "other-window": "Original prompt",
        };
        expect(draftText()).toBe(expected[edit]);
        if (edit === "attachment") {
          expect(
            useWorkspaceAttachmentsStore.getState().attachmentsByScope[SCOPE_KEY],
          ).toHaveLength(1);
        }
      } finally {
        await store.finishDraftTitle(id);
      }
    },
  );
});
