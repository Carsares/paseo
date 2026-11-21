import { describe, expect, it } from "vitest";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { WorkspaceLayoutPersistedStateSchema } from "@/stores/workspace-layout-storage";
import { normalizeWorkspaceTabTarget, workspaceTabTargetsEqual } from "./identity";
import { buildWorkspaceTabPersistenceKey, type WorkspaceDraftTabSetup } from "./model";

describe("WorkspaceDraftTabSetup", () => {
  it("retains the fork source and message boundary through layout storage", () => {
    const draftId = "workspace-fork-draft";
    const setup: WorkspaceDraftTabSetup = {
      provider: "codex",
      cwd: "/workspace/project",
      modeId: null,
      model: null,
      thinkingOptionId: null,
      providerOptions: {},
      forkFrom: {
        sourceAgentId: "source-agent",
        boundaryMessageId: "message-7",
        boundaryCursor: { epoch: "previous", seq: 7 },
      },
    };
    const target = normalizeWorkspaceTabTarget({ kind: "draft", draftId, setup });
    if (target?.kind !== "draft") throw new Error("Expected a normalized draft tab");
    const layout = {
      layoutByWorkspace: {
        workspace: {
          root: {
            kind: "pane",
            pane: {
              id: "pane",
              tabIds: [draftId],
              focusedTabId: draftId,
              tabs: [{ tabId: draftId, target: { kind: "draft", draftId, setup }, createdAt: 1 }],
            },
          },
          focusedPaneId: "pane",
        },
      },
    };
    const restoredRoot = WorkspaceLayoutPersistedStateSchema.parse(
      JSON.parse(JSON.stringify(layout)),
    ).layoutByWorkspace.workspace?.root;
    if (restoredRoot?.kind !== "pane") throw new Error("Expected a restored pane");
    const restored = collectAllTabs(restoredRoot)[0]?.target;
    if (!restored) throw new Error("Expected a restored draft tab");
    expect(restored).toEqual({
      kind: "draft",
      draftId,
      setup: { ...setup, restoreChatHistory: false },
    });
    expect(workspaceTabTargetsEqual(target, restored)).toBe(true);
    expect(
      workspaceTabTargetsEqual(target, {
        ...target,
        setup: {
          ...setup,
          forkFrom: {
            sourceAgentId: "source-agent",
            boundaryMessageId: "message-7",
            boundaryCursor: { epoch: "previous", seq: 8 },
          },
        },
      }),
    ).toBe(false);
  });
});

describe("buildWorkspaceTabPersistenceKey", () => {
  it("trims and joins opaque server and workspace ids", () => {
    expect(
      buildWorkspaceTabPersistenceKey({
        serverId: "  server-1  ",
        workspaceId: "  setup\\workspace\\  ",
      }),
    ).toBe("server-1:setup\\workspace\\");
  });

  it("rejects incomplete identities", () => {
    expect(buildWorkspaceTabPersistenceKey({ serverId: "", workspaceId: "workspace" })).toBeNull();
    expect(buildWorkspaceTabPersistenceKey({ serverId: "server", workspaceId: "  " })).toBeNull();
  });
});
