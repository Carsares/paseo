import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuoteAttachment } from "@/attachments/quote";
import type { ComposerAttachment } from "@/attachments/types";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { encodeImages } from "@/utils/encode-images";
import { submitActiveTopicReply, submitQuotedTopicReplyIfMatched } from "./submit-topic-reply";

vi.mock("@/utils/encode-images", () => ({
  encodeImages: vi.fn(),
}));

const SERVER_ID = "srv-1";
const WORKSPACE_ID = "ws-1";
const MAIN_AGENT_ID = "main-1";

describe("submitQuotedTopicReplyIfMatched", () => {
  const replyWorkspaceTopic = vi.fn();
  const sendAgentMessage = vi.fn();
  const uploadFile = vi.fn();

  beforeEach(() => {
    replyWorkspaceTopic.mockReset().mockResolvedValue({
      routedTo: "lead",
      targetAgentId: "lead-1",
      entry: null,
      error: null,
    });
    sendAgentMessage.mockReset().mockResolvedValue(undefined);
    uploadFile.mockReset().mockResolvedValue({
      requestId: "upload-req-1",
      file: {
        type: "uploaded_file",
        id: "uploaded-img-1",
        path: "/tmp/screenshot.png",
        fileName: "screenshot.png",
        mimeType: "image/png",
        size: 64,
      },
      error: null,
    });
    vi.mocked(encodeImages)
      .mockReset()
      .mockResolvedValue([{ data: "AA==", mimeType: "image/png" }]);
    vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
      connectionStatus: "online",
      client: { replyWorkspaceTopic, sendAgentMessage, uploadFile },
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes a single-topic main composer quote (with files and images) directly into the original topic", async () => {
    const fileAttachment: Extract<ComposerAttachment, { kind: "file" }> = {
      kind: "file",
      attachment: {
        type: "uploaded_file",
        id: "file-1",
        path: "/tmp/logs.txt",
        fileName: "logs.txt",
        mimeType: "text/plain",
        size: 120,
      },
    };
    const imageAttachment: Extract<ComposerAttachment, { kind: "image" }> = {
      kind: "image",
      metadata: {
        id: "img-1",
        mimeType: "image/png",
        fileName: "screenshot.png",
        storageType: "web-indexeddb",
        storageKey: "img-1",
        createdAt: 1,
      },
    };
    const quote1 = createQuoteAttachment({
      id: "q-1",
      text: "First clue from topic A",
      label: "Lead A",
      topicKey: "task:T-1",
      taskId: "T-1",
      rootMessageId: "m-1",
    });
    const quote2 = createQuoteAttachment({
      id: "q-2",
      text: "Second clue from same topic A",
      topicKey: "task:T-1",
    });

    const result = await submitQuotedTopicReplyIfMatched({
      queryClient: new QueryClient(),
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: MAIN_AGENT_ID,
      isMainControlStream: true,
      activeReplyTopic: null,
      payload: {
        text: "Please check these logs too",
        attachments: [quote1, fileAttachment, quote2, imageAttachment],
        cwd: "/repo",
      },
      supportsTopicThreads: true,
      supportsForgeAttachments: true,
      disconnectedMessage: "Host disconnected",
    });

    expect(result).toEqual({
      routed: true,
      sent: true,
      target: expect.objectContaining({
        topicKey: "task:T-1",
        taskId: "T-1",
        rootMessageId: "m-1",
        routeMode: "auto",
      }),
    });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(replyWorkspaceTopic).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        mainAgentId: MAIN_AGENT_ID,
        topicKey: "task:T-1",
        taskId: "T-1",
        rootMessageId: "m-1",
        routeMode: "auto",
        text: "> First clue from topic A\n\n> Second clue from same topic A\n\nPlease check these logs too",
        attachments: [
          fileAttachment.attachment,
          expect.objectContaining({ id: "uploaded-img-1", fileName: "screenshot.png" }),
        ],
      }),
    );
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("does not hard-route when two or more distinct topics are quoted (cross-topic coordination)", async () => {
    const quoteA = createQuoteAttachment({
      id: "q-a",
      text: "From topic A",
      topicKey: "task:T-1",
      taskId: "T-1",
      rootMessageId: "m-1",
    });
    const quoteB = createQuoteAttachment({
      id: "q-b",
      text: "From topic B",
      topicKey: "task:T-2",
      taskId: "T-2",
      rootMessageId: "m-2",
    });

    const result = await submitQuotedTopicReplyIfMatched({
      queryClient: new QueryClient(),
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: MAIN_AGENT_ID,
      isMainControlStream: true,
      activeReplyTopic: null,
      payload: {
        text: "Coordinate T-1 and T-2 together",
        attachments: [quoteA, quoteB],
        cwd: "/repo",
      },
      supportsTopicThreads: true,
      supportsForgeAttachments: true,
      disconnectedMessage: "Host disconnected",
    });

    expect(result).toEqual({ routed: false });
    expect(replyWorkspaceTopic).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("preserves explicit activeReplyTopic card replies without interference", async () => {
    const explicitTarget = {
      topicKey: "task:T-active",
      taskId: "T-active",
      rootMessageId: "m-active",
      promptPreview: "Active topic",
      routeMode: "main" as const,
    };
    const quoteOther = createQuoteAttachment({
      id: "q-other",
      text: "Referenced from another topic",
      topicKey: "task:T-other",
      taskId: "T-other",
    });

    const matchResult = await submitQuotedTopicReplyIfMatched({
      queryClient: new QueryClient(),
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: MAIN_AGENT_ID,
      isMainControlStream: true,
      activeReplyTopic: explicitTarget,
      payload: {
        text: "Reply inside active card",
        attachments: [quoteOther],
        cwd: "/repo",
      },
      supportsTopicThreads: true,
      supportsForgeAttachments: true,
      disconnectedMessage: "Host disconnected",
    });
    expect(matchResult).toEqual({ routed: false });

    const sent = await submitActiveTopicReply({
      queryClient: new QueryClient(),
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: MAIN_AGENT_ID,
      activeReplyTopic: explicitTarget,
      payload: {
        text: "Reply inside active card",
        attachments: [quoteOther],
        cwd: "/repo",
      },
      supportsTopicThreads: true,
      supportsForgeAttachments: true,
      disconnectedMessage: "Host disconnected",
    });

    expect(sent).toBe(true);
    expect(replyWorkspaceTopic).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        topicKey: "task:T-active",
        taskId: "T-active",
        rootMessageId: "m-active",
        routeMode: "main",
        text: "> Referenced from another topic\n\nReply inside active card",
      }),
    );
  });

  it("skips quoted routing for plain quotes, non-main streams, or legacy hosts", async () => {
    const plainQuote = createQuoteAttachment({ id: "q-plain", text: "Unattributed quote" });
    const topicQuote = createQuoteAttachment({
      id: "q-topic",
      text: "Topic quote",
      topicKey: "msg:m-9",
      rootMessageId: "m-9",
    });

    expect(
      await submitQuotedTopicReplyIfMatched({
        queryClient: new QueryClient(),
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        agentId: MAIN_AGENT_ID,
        isMainControlStream: true,
        payload: { text: "Hello", attachments: [plainQuote], cwd: "/repo" },
        supportsTopicThreads: true,
        supportsForgeAttachments: true,
        disconnectedMessage: "Host disconnected",
      }),
    ).toEqual({ routed: false });

    expect(
      await submitQuotedTopicReplyIfMatched({
        queryClient: new QueryClient(),
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        agentId: MAIN_AGENT_ID,
        isMainControlStream: false,
        payload: { text: "Hello", attachments: [topicQuote], cwd: "/repo" },
        supportsTopicThreads: true,
        supportsForgeAttachments: true,
        disconnectedMessage: "Host disconnected",
      }),
    ).toEqual({ routed: false });

    expect(
      await submitQuotedTopicReplyIfMatched({
        queryClient: new QueryClient(),
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        agentId: MAIN_AGENT_ID,
        isMainControlStream: true,
        payload: { text: "Hello", attachments: [topicQuote], cwd: "/repo" },
        supportsTopicThreads: false,
        supportsForgeAttachments: true,
        disconnectedMessage: "Host disconnected",
      }),
    ).toEqual({ routed: false });

    expect(replyWorkspaceTopic).not.toHaveBeenCalled();
  });
});
