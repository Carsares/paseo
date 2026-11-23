import { describe, expect, it } from "vitest";
import {
  canChooseWorkspaceMain,
  workspaceMainBlock,
  workspaceMainDraftKey,
} from "./workspace-main-intent";
import { createWorkspaceMainPreferences } from "./workspace-main-preference";

function makeStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: async (key: string) => entries.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: async (key: string) => {
      entries.delete(key);
    },
  };
}

describe("workspace main draft intent", () => {
  it("restores the empty draft choice only for the same draft, host and target", async () => {
    const storage = makeStorage();
    const original = createWorkspaceMainPreferences(storage);
    const scope = {
      draftId: "draft",
      serverId: "host",
      target: { kind: "new", projectId: "project", directory: "/repo", isolation: "local" },
    } as const;
    const key = workspaceMainDraftKey(scope)!;
    await original.set(key, true);

    const reloaded = createWorkspaceMainPreferences(storage);
    expect(reloaded.get(key)).toBeUndefined();
    await reloaded.load(key);
    expect(reloaded.get(key)).toBe(true);

    for (const other of [
      { ...scope, draftId: "other-draft" },
      { ...scope, serverId: "other-host" },
      { ...scope, target: { ...scope.target, projectId: "other-project" } },
      { ...scope, target: { ...scope.target, directory: "/other" } },
      { ...scope, target: { ...scope.target, isolation: "worktree" as const } },
      { ...scope, target: { kind: "workspace" as const, workspaceId: "/repo" } },
    ]) {
      const otherKey = workspaceMainDraftKey(other)!;
      await reloaded.load(otherKey);
      expect(reloaded.get(otherKey)).toBe(false);
    }
    expect(reloaded.get(key)).toBe(true);
    await reloaded.set(key, false);
    const cleared = createWorkspaceMainPreferences(storage);
    await cleared.load(key);
    expect(cleared.get(key)).toBe(false);
  });

  it("keeps independent drafts eligible and excludes terminal, handoff and explicit child drafts", () => {
    const setup = {
      provider: "codex",
      cwd: "/repo",
      model: null,
      modeId: null,
      thinkingOptionId: null,
      providerOptions: {},
    };
    expect(canChooseWorkspaceMain({ setup })).toBe(true);
    expect(canChooseWorkspaceMain({ isTerminal: true })).toBe(false);
    expect(canChooseWorkspaceMain({ isHandoff: true })).toBe(false);
    expect(canChooseWorkspaceMain({ setup: { ...setup, parentAgentId: "parent" } })).toBe(false);
    expect(canChooseWorkspaceMain({ setup: { ...setup, restoreChatHistory: true } })).toBe(false);
    expect(
      canChooseWorkspaceMain({
        setup: { ...setup, forkFrom: { sourceAgentId: "source", boundaryMessageId: "turn" } },
      }),
    ).toBe(false);
  });

  it("only allows creation in a known free workspace or a fresh workspace on a supported host", () => {
    expect(
      workspaceMainBlock({
        supportsCreateAsMain: true,
        target: { kind: "workspace", hasActiveMainAgent: true },
      }),
    ).toBe("occupied");
    expect(
      workspaceMainBlock({
        supportsCreateAsMain: true,
        target: { kind: "workspace" },
      }),
    ).toBe("unknown");
    expect(
      workspaceMainBlock({
        supportsCreateAsMain: true,
        target: { kind: "workspace", hasActiveMainAgent: false },
      }),
    ).toBeNull();
    expect(
      workspaceMainBlock({
        supportsCreateAsMain: true,
        target: { kind: "new" },
      }),
    ).toBeNull();
    expect(
      workspaceMainBlock({
        supportsCreateAsMain: false,
        target: { kind: "new" },
      }),
    ).toBe("unsupported");
  });
});
