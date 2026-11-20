/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  resetWorkspaceAttachmentsStore,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { openForkSourceAgent } from "@/utils/navigate-to-agent";
import { composerWorkspaceAttachment } from "./workspace";
import { removeSentContextAttachments } from "./workspace-cleanup";

vi.mock("lucide-react-native", () => import("../../../test-stubs/lucide-react-native"));
vi.mock("react-native-unistyles", () => import("../../../test-stubs/react-native-unistyles"));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/contexts/toast-api-context", () => ({
  useOptionalToast: () => ({ error: toastError }),
}));
vi.mock("@/utils/navigate-to-agent", () => ({
  openForkSourceAgent: vi.fn(async () => true),
}));

function chatHistoryAttachment(): WorkspaceComposerAttachment {
  return {
    kind: "chat_history",
    id: "chat_history:draft-1",
    attachment: {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
      text: "Previous chat.",
    },
    source: {
      serverId: "local",
      agentId: "agent-1",
    },
  };
}

function pullRequestContextAttachment(): WorkspaceComposerAttachment {
  return {
    kind: "github.pull_request_comment",
    id: "comment-1",
    title: "Comment",
    text: "Please check this.",
  };
}

function browserElementAttachment(): WorkspaceComposerAttachment {
  return {
    kind: "browser_element",
    attachment: {
      url: "https://example.com",
      selector: "button.primary",
      tag: "button",
      text: "Click me",
      outerHTML: '<button class="primary">Click me</button>',
      computedStyles: {},
      boundingRect: { x: 0, y: 0, width: 100, height: 40 },
      reactSource: null,
      parentChain: [],
      children: [],
      formatted: "button.primary\nClick me",
    },
  };
}

describe("workspace composer attachment cleanup", () => {
  it("clears sent scoped context attachments from their stores", () => {
    resetWorkspaceAttachmentsStore();
    const scopeKey = buildDraftWorkspaceAttachmentScopeKey("draft-1");
    const chatHistory = chatHistoryAttachment();
    const pullRequestContext = pullRequestContextAttachment();
    const browserElement = browserElementAttachment();
    useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
      scopeKey,
      attachments: [chatHistory, pullRequestContext, browserElement],
    });

    removeSentContextAttachments([chatHistory, pullRequestContext, browserElement]);

    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey]).toBeUndefined();
  });
});

describe("workspace composer attachment opening", () => {
  beforeEach(() => {
    vi.mocked(openForkSourceAgent).mockClear();
    toastError.mockClear();
  });

  function renderBinding(workspaceAttachments: WorkspaceComposerAttachment[]) {
    return renderHook(() =>
      composerWorkspaceAttachment.useBinding({ normalAttachments: [], workspaceAttachments }),
    );
  }

  it("opens the fork source agent when a chat history attachment is opened", () => {
    const attachment = chatHistoryAttachment();
    const { result } = renderBinding([attachment]);

    expect(result.current.openAttachment({ attachment })).toBe(true);

    expect(openForkSourceAgent).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "local", sourceAgentId: "agent-1" }),
    );
  });

  it("shows a toast when looking up a draft history source fails", () => {
    const attachment = chatHistoryAttachment();
    vi.mocked(openForkSourceAgent).mockImplementationOnce(async (input) => {
      input.onError?.(new Error("History lookup failed"));
      return false;
    });
    const { result } = renderBinding([attachment]);

    expect(result.current.openAttachment({ attachment })).toBe(true);
    expect(toastError).toHaveBeenCalledExactlyOnceWith("History lookup failed");
  });

  it("does not open anything for a chat history attachment without a source agent", () => {
    const attachment = chatHistoryAttachment();
    if (attachment.kind !== "chat_history") throw new Error("expected chat history");
    const withoutSource = { ...attachment, source: { ...attachment.source, agentId: " " } };
    const { result } = renderBinding([withoutSource]);

    expect(result.current.openAttachment({ attachment: withoutSource })).toBe(false);

    expect(openForkSourceAgent).not.toHaveBeenCalled();
  });
});
