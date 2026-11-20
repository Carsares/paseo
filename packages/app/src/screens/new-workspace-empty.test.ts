import { describe, expect, it, vi } from "vitest";
import type { ComposerAttachment } from "@/attachments/types";
import type { MessagePayload } from "@/composer/types";
import {
  isEmptyWorkspaceSubmission,
  resolveEmptyWorkspaceMainProvider,
  runCreateEmptyWorkspace,
} from "./new-workspace-empty";

function payload(
  input: { text?: string; attachments?: ComposerAttachment[] } = {},
): MessagePayload {
  return { text: input.text ?? "", attachments: input.attachments ?? [], cwd: "/sample/repo" };
}

function createRecordingNavigate() {
  const recorded: Array<{ serverId: string; workspaceId: string; mainAgentId?: string }> = [];
  return {
    recorded,
    navigate: (serverId: string, workspaceId: string, mainAgentId?: string) => {
      recorded.push({ serverId, workspaceId, mainAgentId });
    },
  };
}

describe("runCreateEmptyWorkspace", () => {
  it("creates a workspace without prompt or attachments and navigates to it", async () => {
    const workspace = { id: "workspace-123" };
    const ensureWorkspace = vi.fn().mockResolvedValue({ workspace });
    const { navigate, recorded } = createRecordingNavigate();

    await runCreateEmptyWorkspace({
      payload: payload(),
      ensureWorkspace,
      serverId: "server-abc",
      navigate,
    });

    expect(ensureWorkspace).toHaveBeenCalledOnce();
    expect(ensureWorkspace).toHaveBeenCalledWith({
      cwd: "/sample/repo",
      prompt: "",
      attachments: [],
      withInitialAgent: false,
    });
    expect(recorded).toEqual([{ serverId: "server-abc", workspaceId: "workspace-123" }]);
  });

  it("opens the silent Main Tab when the host returns one", async () => {
    const workspace = { id: "workspace-123" };
    const ensureWorkspace = vi.fn().mockResolvedValue({ workspace, mainAgent: { id: "main-1" } });
    const { navigate, recorded } = createRecordingNavigate();

    await runCreateEmptyWorkspace({
      payload: payload(),
      ensureWorkspace,
      serverId: "server-abc",
      navigate,
    });

    expect(recorded).toEqual([
      { serverId: "server-abc", workspaceId: "workspace-123", mainAgentId: "main-1" },
    ]);
  });
});

describe("resolveEmptyWorkspaceMainProvider", () => {
  it("uses a ready provider on the selected host when the saved provider is unavailable", () => {
    expect(
      resolveEmptyWorkspaceMainProvider({
        selectedProvider: "claude",
        preferredProvider: "claude",
        entries: [
          { provider: "claude", enabled: false, status: "ready" },
          { provider: "codex", enabled: true, status: "loading" },
          { provider: "pi", enabled: true, status: "ready" },
        ],
      }),
    ).toBe("pi");
  });
});

describe("isEmptyWorkspaceSubmission", () => {
  it("treats whitespace-only text with no attachments as empty, but any attachment as non-empty", () => {
    const attachment: ComposerAttachment = {
      kind: "image",
      metadata: {
        id: "image-1",
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "image-1",
        createdAt: 0,
      },
    };

    expect(isEmptyWorkspaceSubmission(payload({ text: " \n\t " }))).toBe(true);
    expect(isEmptyWorkspaceSubmission(payload({ attachments: [attachment] }))).toBe(false);
  });
});
