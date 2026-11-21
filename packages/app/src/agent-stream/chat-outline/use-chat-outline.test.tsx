// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { createRef, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { StreamItem } from "@/types/stream";
import { createNativeReadingPositionTracker } from "../native-reading-position";
import type { StreamViewportHandle } from "../strategy";
import { ActivePromptBar } from "./active-prompt-bar";
import type { ChatOutlinePrompt } from "./model";
import { shouldTrackChatOutline, useChatOutline, type ChatOutline } from "./use-chat-outline";

const runtime = vi.hoisted(() => ({
  listAgentTimelinePrompts: vi.fn(),
  fetchAgentTimeline: vi.fn(),
  subscribeAgentTimeline: vi.fn(() => {
    throw new Error("The outline must reuse the viewed timeline");
  }),
}));

vi.mock("@/constants/platform", () => ({ isWeb: false, isNative: true }));
vi.mock("lucide-react-native", async (importOriginal) => {
  const icons = await importOriginal<typeof import("lucide-react-native")>();
  return { ...icons, ChevronUp: icons.ChevronDown };
});

const connectionListeners = new Set<() => void>();
let connection: { connectionStatus: "online" | "offline"; connectionEpoch: number };

function publishConnection(online: boolean) {
  const connectionStatus = online ? "online" : "offline";
  connection = {
    connectionStatus,
    connectionEpoch:
      connection.connectionEpoch + (online && connection.connectionStatus === "offline" ? 1 : 0),
  };
  for (const listener of connectionListeners) listener();
}

vi.mock("@/runtime/host-runtime", () => {
  const store = {
    getClient: () => runtime,
    getSnapshot: () => connection,
    subscribe: (_serverId: string, listener: () => void) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    fetchAgentTimeline: runtime.fetchAgentTimeline,
  };
  return { getHostRuntimeStore: () => store };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function useReportInitialReading(
  reportReadingPosition: ChatOutline["reportReadingPosition"],
  timelineEpoch: string | null,
) {
  useLayoutEffect(() => {
    if (timelineEpoch !== null) reportReadingPosition(18, false);
  }, [reportReadingPosition, timelineEpoch]);
}

function useReportStationaryNativeReading(
  reportReadingPosition: ChatOutline["reportReadingPosition"],
  epoch: string,
  seq: number,
) {
  const [tracker] = useState(createNativeReadingPositionTracker);
  useLayoutEffect(() => {
    tracker.report("same-visible-row", () => reportReadingPosition(seq), epoch);
  }, [epoch, reportReadingPosition, seq, tracker]);
}

describe("useChatOutline", () => {
  beforeEach(() => {
    connection = { connectionStatus: "online", connectionEpoch: 1 };
    runtime.listAgentTimelinePrompts.mockReset();
    runtime.fetchAgentTimeline.mockReset();
    runtime.subscribeAgentTimeline.mockClear();
  });

  afterEach(cleanup);

  it("requests the native prompt index only after the host advertises it", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({ epoch: "epoch", prompts: [] });
    const viewportRef = createRef<StreamViewportHandle>();
    const { rerender } = renderHook(
      ({ supportsPromptIndex }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch: "epoch",
          tail: [],
          head: [],
          enabled: shouldTrackChatOutline({
            isNative: true,
            railEnabled: false,
            supportsPromptIndex,
          }),
          viewportRef,
          onJumpError: vi.fn(),
        }),
      { initialProps: { supportsPromptIndex: false } },
    );
    await act(async () => {
      publishConnection(false);
      publishConnection(true);
    });
    expect(runtime.listAgentTimelinePrompts).not.toHaveBeenCalled();
    rerender({ supportsPromptIndex: true });
    await waitFor(() =>
      expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledExactlyOnceWith("agent-1"),
    );
    rerender({ supportsPromptIndex: false });
    await act(async () => {});
    expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(1);
  });

  it("waits for a served timeline before requesting its prompt index", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({ epoch: "epoch-1", prompts: [] });
    const viewportRef = createRef<StreamViewportHandle>();
    const { rerender } = renderHook(
      ({ agentId, timelineEpoch }) =>
        useChatOutline({
          agentId,
          serverId: "server-1",
          timelineEpoch,
          tail: [],
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
        }),
      { initialProps: { agentId: "draft_msg_1", timelineEpoch: null as string | null } },
    );

    expect(runtime.listAgentTimelinePrompts).not.toHaveBeenCalled();

    rerender({ agentId: "agent-1", timelineEpoch: "epoch-1" });
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(1));
    expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledWith("agent-1");
  });

  it.each([
    { seq: 1, isPromptRow: true },
    { seq: 2, isPromptRow: false },
  ])(
    "uses the initial native reading position when the prompt index arrives ($seq)",
    async ({ seq, isPromptRow }) => {
      const first = deferred<{ epoch: string; prompts: ChatOutlinePrompt[] }>();
      const prompt = { seq: 1, timestamp: new Date(1).toISOString(), preview: "Current prompt" };
      runtime.listAgentTimelinePrompts
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({ epoch: "epoch-2", prompts: [prompt] });
      const viewportRef = createRef<StreamViewportHandle>();
      const { result, rerender } = renderHook(
        ({ timelineEpoch }) =>
          useChatOutline({
            agentId: "agent-1",
            serverId: "server-1",
            timelineEpoch,
            tail: [],
            head: [],
            enabled: true,
            viewportRef,
            onJumpError: vi.fn(),
          }),
        { initialProps: { timelineEpoch: "epoch-1" } },
      );

      expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledWith("agent-1");
      act(() => result.current.reportReadingPosition(seq, isPromptRow));
      await act(async () => first.resolve({ epoch: "epoch-1", prompts: [prompt] }));
      expect(result.current.prompts).toEqual([prompt]);
      const outline = result.current;
      expect(outline.activePrompt.getReadingState()).toEqual({
        activeSeq: 1,
        isPromptScrolledAbove: !isPromptRow,
      });

      act(() => {
        outline.reportReadingPosition(1, true);
        outline.reportReadingPosition(2, false);
      });
      expect(result.current).toBe(outline);
      expect(outline.activePrompt.getReadingState()).toEqual({
        activeSeq: 1,
        isPromptScrolledAbove: true,
      });

      rerender({ timelineEpoch: "epoch-2" });
      await waitFor(() => expect(result.current.prompts).toEqual([prompt]));
      expect(outline.activePrompt.getReadingState()).toEqual({
        activeSeq: null,
        isPromptScrolledAbove: false,
      });
    },
  );

  it("updates the active prompt and jump when a stationary native reading row changes epoch", async () => {
    const first = { seq: 1, timestamp: new Date(1).toISOString(), preview: "Original prompt" };
    const replacement = {
      seq: 15,
      timestamp: new Date(15).toISOString(),
      preview: "Replacement prompt",
    };
    runtime.listAgentTimelinePrompts
      .mockResolvedValueOnce({ epoch: "epoch-a", prompts: [first] })
      .mockResolvedValueOnce({ epoch: "epoch-b", prompts: [replacement] });
    runtime.fetchAgentTimeline.mockResolvedValue(undefined);
    const viewportRef = createRef<StreamViewportHandle>();
    const { result, rerender } = renderHook(
      ({ epoch, seq }) => {
        const outline = useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch: epoch,
          tail: [],
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
        });
        useReportStationaryNativeReading(outline.reportReadingPosition, epoch, seq);
        return outline;
      },
      { initialProps: { epoch: "epoch-a", seq: 2 } },
    );
    await waitFor(() => expect(result.current.activePrompt.getReadingState().activeSeq).toBe(1));
    rerender({ epoch: "epoch-b", seq: 16 });
    await waitFor(() => expect(result.current.activePrompt.getReadingState().activeSeq).toBe(15));
    await act(async () => result.current.jumpToPrompt(15));
    expect(runtime.fetchAgentTimeline).toHaveBeenCalledExactlyOnceWith(
      "server-1",
      "agent-1",
      expect.objectContaining({ cursor: { epoch: "epoch-b", seq: 36 } }),
    );
  });

  it("preserves a reading row reported during the layout of a newly served timeline", async () => {
    const prompt = { seq: 4, timestamp: new Date(4).toISOString(), preview: "Latest prompt" };
    const response = deferred<{ epoch: string; prompts: ChatOutlinePrompt[] }>();
    runtime.listAgentTimelinePrompts.mockReturnValue(response.promise);
    const viewportRef = createRef<StreamViewportHandle>();
    const { result, rerender } = renderHook(
      ({ timelineEpoch }: { timelineEpoch: string | null }) => {
        const outline = useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch,
          tail: [],
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
        });
        useReportInitialReading(outline.reportReadingPosition, timelineEpoch);
        return outline;
      },
      { initialProps: { timelineEpoch: null as string | null } },
    );

    rerender({ timelineEpoch: "epoch-1" });
    await act(async () => response.resolve({ epoch: "epoch-1", prompts: [prompt] }));
    expect(result.current.activePrompt.getReadingState()).toEqual({
      activeSeq: 4,
      isPromptScrolledAbove: true,
    });
  });

  it("drops a late prompt index after the authoritative timeline epoch changes", async () => {
    const first = deferred<{ epoch: string; prompts: [] }>();
    const second = deferred<{
      epoch: string;
      prompts: Array<{ seq: number; timestamp: string; preview: string }>;
    }>();
    runtime.listAgentTimelinePrompts
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const viewportRef = createRef<StreamViewportHandle>();
    const { result, rerender } = renderHook(
      ({ timelineEpoch }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch,
          tail: [],
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
        }),
      { initialProps: { timelineEpoch: "epoch-1" } },
    );
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(1));

    rerender({ timelineEpoch: "epoch-2" });
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve({ epoch: "epoch-1", prompts: [] }));
    expect(result.current.prompts).toEqual([]);

    await act(async () =>
      second.resolve({
        epoch: "epoch-2",
        prompts: [{ seq: 2, timestamp: new Date(2).toISOString(), preview: "current prompt" }],
      }),
    );
    await waitFor(() => {
      expect(result.current.prompts).toHaveLength(1);
    });
    expect(result.current.prompts[0]?.seq).toBe(2);
  });

  it("refreshes from viewed user messages without another stream and keeps the newest index", async () => {
    const older = deferred<{
      epoch: string;
      prompts: Array<{ seq: number; timestamp: string; preview: string }>;
    }>();
    const newer = deferred<{
      epoch: string;
      prompts: Array<{ seq: number; timestamp: string; preview: string }>;
    }>();
    runtime.listAgentTimelinePrompts
      .mockResolvedValueOnce({ epoch: "epoch-1", prompts: [] })
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const viewportRef = createRef<StreamViewportHandle>();
    const { result, rerender } = renderHook(
      ({ tail }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch: "epoch-1",
          tail,
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
        }),
      { initialProps: { tail: [] as import("@/types/stream").StreamItem[] } },
    );
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(1));
    const loadedPrompt = (seq: number): import("@/types/stream").StreamItem => ({
      id: `prompt-${seq}`,
      kind: "user_message",
      text: "live prompt",
      timestamp: new Date(seq),
      timelineCursor: { epoch: "epoch-1", seq },
    });
    rerender({ tail: [loadedPrompt(2)] });
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(2));
    rerender({ tail: [loadedPrompt(2), loadedPrompt(3)] });
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(3));
    await act(async () =>
      newer.resolve({
        epoch: "epoch-1",
        prompts: [{ seq: 3, timestamp: new Date(3).toISOString(), preview: "newer" }],
      }),
    );
    await act(async () =>
      older.resolve({
        epoch: "epoch-1",
        prompts: [{ seq: 2, timestamp: new Date(2).toISOString(), preview: "older" }],
      }),
    );

    expect(result.current.prompts.map((prompt) => prompt.seq)).toEqual([3]);
    expect(runtime.subscribeAgentTimeline).not.toHaveBeenCalled();
  });

  it("refreshes after reconnect catch-up and visibility changes without reacting to assistant chunks", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 1, timestamp: new Date(1).toISOString(), preview: "Unloaded prompt" }],
    });
    const viewportRef = createRef<StreamViewportHandle>();
    const { result, rerender } = renderHook(
      ({ enabled, head, timelineEpoch }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          tail: [],
          head,
          timelineEpoch,
          enabled,
          viewportRef,
          mountedHistoryMessageIds: new Set(),
          onJumpError: vi.fn(),
        }),
      {
        initialProps: {
          enabled: true,
          head: [] as import("@/types/stream").StreamItem[],
          timelineEpoch: "epoch-1",
        },
      },
    );
    await waitFor(() => expect(result.current.prompts[0]?.preview).toBe("Unloaded prompt"));
    rerender({
      enabled: true,
      head: [
        {
          id: "assistant",
          kind: "assistant_message",
          text: "chunk",
          timestamp: new Date(),
          timelineCursor: { epoch: "epoch-1", seq: 2 },
        },
      ],
      timelineEpoch: "epoch-1",
    });
    expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(1);
    rerender({ enabled: false, head: [], timelineEpoch: "epoch-1" });
    expect(result.current.prompts).toEqual([]);
    // The viewed model publishes the catch-up from the reconnected transport.
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-2",
      prompts: [{ seq: 1, timestamp: new Date(2).toISOString(), preview: "Replaced conversation" }],
    });
    rerender({
      enabled: true,
      head: [
        {
          id: "reconnected-user",
          kind: "user_message",
          text: "Replaced conversation",
          timestamp: new Date(2),
          timelineCursor: { epoch: "epoch-2", seq: 1 },
        },
      ],
      timelineEpoch: "epoch-2",
    });
    await waitFor(() => expect(result.current.prompts[0]?.preview).toBe("Replaced conversation"));
    expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(2);
    expect(runtime.subscribeAgentTimeline).not.toHaveBeenCalled();
  });

  it.each(["initial request", "refresh after a new prompt"])(
    "restores the native prompt bar and adjacent jumps when reconnect interrupts the %s",
    async (interrupted) => {
      await i18n.changeLanguage("en");
      const previous = {
        seq: 4,
        timestamp: new Date(4).toISOString(),
        preview: "Previous question",
      };
      const current = { seq: 9, timestamp: new Date(9).toISOString(), preview: "Current question" };
      const next = { seq: 21, timestamp: new Date(21).toISOString(), preview: "Next question" };
      const earlierIndex = { epoch: "epoch-1", prompts: [previous] };
      const latestIndex = { epoch: "epoch-1", prompts: [previous, current, next] };
      const pending = deferred<typeof latestIndex>();
      const isRefresh = interrupted === "refresh after a new prompt";
      if (isRefresh) runtime.listAgentTimelinePrompts.mockResolvedValueOnce(earlierIndex);
      runtime.listAgentTimelinePrompts
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(latestIndex);
      runtime.fetchAgentTimeline.mockResolvedValue(undefined);
      const viewportRef = createRef<StreamViewportHandle>();
      const loadedHead: StreamItem[] = [
        {
          kind: "user_message",
          id: "prompt-9",
          text: "Current question",
          timestamp: new Date(9),
          timelineCursor: { epoch: "epoch-1", seq: 9 },
        },
      ];

      function NativePromptBar({ head }: { head: StreamItem[] }) {
        const outline = useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch: "epoch-1",
          tail: [],
          head,
          enabled: shouldTrackChatOutline({
            isNative: true,
            railEnabled: false,
            supportsPromptIndex: true,
          }),
          viewportRef,
          onJumpError: vi.fn(),
        });
        useReportStationaryNativeReading(outline.reportReadingPosition, "epoch-1", 10);
        return (
          <ActivePromptBar
            activePrompt={outline.activePrompt}
            prompts={outline.prompts}
            onJumpToPrompt={outline.jumpToPrompt}
            contentMaxWidth={undefined}
          />
        );
      }

      const view = render(<NativePromptBar head={isRefresh ? [] : loadedHead} />);
      if (isRefresh) {
        await view.findByRole("button", { name: "Prompt 1/1: Previous question" });
        view.rerender(<NativePromptBar head={loadedHead} />);
      }
      const requestsBeforeDisconnect = isRefresh ? 2 : 1;
      expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(requestsBeforeDisconnect);

      await act(async () => {
        publishConnection(false);
        pending.reject(new Error("Client disconnected"));
      });
      expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(requestsBeforeDisconnect);
      const currentPrompt = { name: "Prompt 2/3: Current question" };
      expect(view.queryByRole("button", currentPrompt)).toBeNull();

      // The reconnect uses the same client, feature flag, timeline epoch, and loaded prompt.
      await act(async () => publishConnection(true));
      expect(view.getByRole("button", currentPrompt).textContent).toContain("Current question");

      // Another host notification and a catch-up render with the same prompt don't refresh it.
      await act(async () => publishConnection(true));
      view.rerender(<NativePromptBar head={[...loadedHead]} />);
      expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(requestsBeforeDisconnect + 1);
      expect(runtime.listAgentTimelinePrompts).toHaveBeenLastCalledWith("agent-1");

      await act(async () => {
        fireEvent.click(view.getByTestId("active-prompt-bar-prev"));
        fireEvent.click(view.getByTestId("active-prompt-bar-next"));
      });
      expect(runtime.fetchAgentTimeline).toHaveBeenCalledTimes(2);
      expect(runtime.fetchAgentTimeline).toHaveBeenNthCalledWith(
        1,
        "server-1",
        "agent-1",
        expect.objectContaining({ cursor: { epoch: "epoch-1", seq: 25 } }),
      );
      expect(runtime.fetchAgentTimeline).toHaveBeenNthCalledWith(
        2,
        "server-1",
        "agent-1",
        expect.objectContaining({ cursor: { epoch: "epoch-1", seq: 42 } }),
      );
      expect(runtime.subscribeAgentTimeline).not.toHaveBeenCalled();
    },
  );

  it("reports a failed unloaded prompt jump", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 1, timestamp: new Date(1).toISOString(), preview: "prompt" }],
    });
    runtime.fetchAgentTimeline.mockRejectedValue(new Error("disconnected"));
    const onJumpError = vi.fn();
    const viewportRef = createRef<StreamViewportHandle>();
    const { result } = renderHook(() =>
      useChatOutline({
        agentId: "agent-1",
        serverId: "server-1",
        timelineEpoch: "epoch-1",
        tail: [],
        head: [],
        enabled: true,
        viewportRef,
        onJumpError,
      }),
    );
    await waitFor(() => expect(result.current.prompts).toHaveLength(1));
    await act(async () => result.current.jumpToPrompt(1));

    await waitFor(() => expect(onJumpError).toHaveBeenCalledOnce());
  });

  it("reveals an already-loaded older prompt before scrolling to it", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 1, timestamp: new Date(1).toISOString(), preview: "prompt" }],
    });
    const scrollToMessage = vi.fn();
    const revealLoadedMessage = vi.fn(() => true);
    const viewport: StreamViewportHandle = {
      scrollToBottom: vi.fn(),
      prepareForViewportChange: vi.fn(),
      holdRow: vi.fn(),
      scrollToMessage,
    };
    const viewportRef = { current: viewport };
    const tail = [
      {
        id: "older-prompt",
        kind: "user_message" as const,
        text: "prompt",
        timestamp: new Date(1),
        timelineCursor: { epoch: "epoch-1", seq: 1 },
      },
    ];
    const { result, rerender } = renderHook(
      ({ mountedHistoryMessageIds }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch: "epoch-1",
          tail,
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
          mountedHistoryMessageIds,
          revealLoadedMessage,
        }),
      { initialProps: { mountedHistoryMessageIds: new Set<string>() } },
    );

    await waitFor(() => expect(result.current.prompts).toHaveLength(1));
    await act(async () => result.current.jumpToPrompt(1));
    expect(revealLoadedMessage).toHaveBeenCalledWith("older-prompt");
    expect(scrollToMessage).not.toHaveBeenCalled();

    rerender({ mountedHistoryMessageIds: new Set(["older-prompt"]) });
    await waitFor(() => expect(scrollToMessage).toHaveBeenCalledWith("older-prompt"));
  });

  it("reveals a fetched prompt that lands outside the mounted history window", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 1, timestamp: new Date(1).toISOString(), preview: "prompt" }],
    });
    const fetch = deferred<void>();
    runtime.fetchAgentTimeline.mockReturnValue(fetch.promise);
    const scrollToMessage = vi.fn();
    const revealLoadedMessage = vi.fn(() => true);
    const viewportRef = {
      current: {
        scrollToBottom: vi.fn(),
        prepareForViewportChange: vi.fn(),
        holdRow: vi.fn(),
        scrollToMessage,
      },
    };
    const fetchedPrompt = {
      id: "fetched-prompt",
      kind: "user_message" as const,
      text: "prompt",
      timestamp: new Date(1),
      timelineCursor: { epoch: "epoch-1", seq: 1 },
    };
    const { result, rerender } = renderHook(
      ({ tail, mountedHistoryMessageIds }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch: "epoch-1",
          tail,
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
          mountedHistoryMessageIds,
          revealLoadedMessage,
        }),
      {
        initialProps: {
          tail: [] as (typeof fetchedPrompt)[],
          mountedHistoryMessageIds: new Set<string>(),
        },
      },
    );

    await waitFor(() => expect(result.current.prompts).toHaveLength(1));
    act(() => result.current.jumpToPrompt(1));
    await waitFor(() => expect(runtime.fetchAgentTimeline).toHaveBeenCalledOnce());

    rerender({ tail: [fetchedPrompt], mountedHistoryMessageIds: new Set<string>() });
    await waitFor(() => expect(revealLoadedMessage).toHaveBeenCalledWith(fetchedPrompt.id));
    expect(scrollToMessage).not.toHaveBeenCalled();

    rerender({ tail: [fetchedPrompt], mountedHistoryMessageIds: new Set([fetchedPrompt.id]) });
    await waitFor(() => expect(scrollToMessage).toHaveBeenCalledOnce());
    expect(scrollToMessage).toHaveBeenCalledWith(fetchedPrompt.id);
    await act(async () => fetch.resolve());
  });

  it("jumps directly to a loaded prompt in the live head", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 2, timestamp: new Date(2).toISOString(), preview: "prompt" }],
    });
    const scrollToMessage = vi.fn();
    const viewport: StreamViewportHandle = {
      scrollToBottom: vi.fn(),
      prepareForViewportChange: vi.fn(),
      holdRow: vi.fn(),
      scrollToMessage,
    };
    const livePrompt = {
      id: "live-prompt",
      kind: "user_message" as const,
      text: "prompt",
      timestamp: new Date(2),
      timelineCursor: { epoch: "epoch-1", seq: 2 },
    };
    const revealLoadedMessage = vi.fn();
    revealLoadedMessage.mockReturnValue(false);
    const { result } = renderHook(() =>
      useChatOutline({
        agentId: "agent-1",
        serverId: "server-1",
        timelineEpoch: "epoch-1",
        tail: [],
        head: [livePrompt],
        enabled: true,
        viewportRef: { current: viewport },
        onJumpError: vi.fn(),
        mountedHistoryMessageIds: new Set<string>(),
        revealLoadedMessage,
      }),
    );

    await waitFor(() => expect(result.current.prompts).toHaveLength(1));
    await act(async () => result.current.jumpToPrompt(2));
    expect(scrollToMessage).toHaveBeenCalledWith("live-prompt");
  });
});
