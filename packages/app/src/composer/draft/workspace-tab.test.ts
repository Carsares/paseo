/** @vitest-environment jsdom */
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { createElement, createRef } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  getOpenAgentTabLabel,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { AssistantSelectionQuote } from "@/assistant-selection-copy/quote.web";
import { AllowSubagentForkContext, AssistantForkMenu } from "@/components/assistant-fork-menu";
import { buildSubagentDraftSetup } from "@/hooks/use-fork-agent";
import { DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES } from "@/hooks/use-settings/storage";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { WorkspaceLayoutPersistedStateSchema } from "@/stores/workspace-layout-storage";
import {
  collectAllTabs,
  createWorkspaceLayoutStore,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { getOrCreateClientId } from "@/utils/client-id";
import { clearSubagentOpenTabLabel } from "@/subagents/open-tab-labels";
import { normalizeWorkspaceTabTarget, workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import { describe, expect, test, vi } from "vitest";

import {
  isDraftTabSubmitting,
  revealCreatedDraftAgentTab,
  submitDraftCreateRequest,
  useInitialDraftText,
} from "./workspace-tab";
import { shouldAllowEmptyDraftText, validateDraftSubmission } from "./workspace-tab-core";

vi.mock("@/composer", () => ({ Composer: () => null }));
vi.mock("@/composer/draft/input-draft", () => ({ useAgentInputDraft: vi.fn() }));
vi.mock("@/subagents/parent", () => ({ ParentAgentPill: () => null }));
vi.mock("lucide-react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("lucide-react-native")>()),
  TextQuote: () => null,
}));

const baseComposerState = {
  providerDefinitions: [{ id: "codewhale" }],
  selectedProvider: "codewhale",
  isModelLoading: false,
  effectiveModelId: "",
  availableModels: [],
};

function validate(overrides = {}) {
  return validateDraftSubmission({
    text: "hello",
    allowsEmptyAutoSubmit: false,
    composerState: baseComposerState,
    autoSubmitConfig: null,
    workspaceDirectory: "/tmp/project",
    isConnected: true,
    ...overrides,
  });
}

describe("workspace draft agent model validation", () => {
  test("reports an offline host before an absent catalog or pending model defaults", () => {
    expect(
      validate({
        isConnected: false,
        composerState: {
          ...baseComposerState,
          providerDefinitions: [],
          selectedProvider: null,
          isModelLoading: true,
        },
      }),
    ).toBe("Host is not connected");
  });

  test("allows a ready provider with no models to submit without a selected model", () => {
    expect(validate({})).toBeNull();
  });

  test("keeps waiting while model defaults are loading", () => {
    expect(
      validate({
        composerState: {
          ...baseComposerState,
          isModelLoading: true,
        },
      }),
    ).toBe("Model defaults are still loading");
  });

  test("still requires a selected model when the provider exposes models", () => {
    expect(
      validate({
        composerState: {
          ...baseComposerState,
          availableModels: [{ id: "deepseek/deepseek-v4-pro" }],
        },
      }),
    ).toBe("No model is available for the selected provider");
  });
});

describe("workspace draft empty text readiness", () => {
  test("allows attachment-only retries after a fork draft create fails", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: false,
        attachments: [{ kind: "chat_history" }],
      }),
    ).toBe(true);
  });

  test("still rejects empty drafts with no auto-submit and no attachments", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: false,
        attachments: [],
      }),
    ).toBe(false);
  });
});

describe("workspace subagent draft", () => {
  test("preserves parentage and Markdown whitespace through layout storage", () => {
    const initialDraftText = "> Selected text\n\n";
    const target = normalizeWorkspaceTabTarget({
      kind: "draft",
      draftId: "draft-1",
      setup: {
        provider: "codewhale",
        cwd: "/tmp/project",
        modeId: null,
        model: null,
        thinkingOptionId: null,
        providerOptions: {},
        parentAgentId: " agent-1 ",
        initialDraftText,
      },
    });
    if (target?.kind !== "draft" || !target.setup) throw new Error("Expected a draft setup");
    const persisted = WorkspaceLayoutPersistedStateSchema.parse(
      JSON.parse(
        JSON.stringify({
          layoutByWorkspace: {
            workspace: {
              root: {
                kind: "pane",
                pane: {
                  id: "pane",
                  tabIds: ["tab"],
                  focusedTabId: "tab",
                  tabs: [{ tabId: "tab", target, createdAt: 1 }],
                },
              },
              focusedPaneId: "pane",
            },
          },
        }),
      ),
    );
    const root = persisted.layoutByWorkspace.workspace?.root;
    const restored = root && collectAllTabs(root)[0]?.target;
    if (!restored) throw new Error("Expected a restored draft tab");
    expect(restored).toMatchObject({ setup: { parentAgentId: "agent-1", initialDraftText } });
    expect(workspaceTabTargetsEqual(target, restored)).toBe(true);
    expect(
      workspaceTabTargetsEqual(target, {
        ...target,
        setup: { ...target.setup, parentAgentId: "another-agent" },
      }),
    ).toBe(false);
  });

  test.each(["parent-agent", null])(
    "marks the first prompt as user input when the draft has a parent (%s)",
    async (parentAgentId) => {
      const result = {
        id: "created-agent",
        provider: "codewhale",
        cwd: "/tmp/project",
        model: null,
        createdAt: "",
        updatedAt: "",
        lastUserMessageAt: null,
        status: "idle" as const,
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: false,
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
        labels: {},
      };
      const createAgent = vi.fn<DaemonClient["createAgent"]>().mockResolvedValue(result);
      await expect(
        submitDraftCreateRequest({
          draftId: "draft-1",
          parentAgentId,
          attempt: { clientMessageId: "message-1" },
          text: "Investigate this",
          cwd: "/tmp/project",
          client: { createAgent },
          workspaceDirectory: "/tmp/project",
          workspaceId: "workspace-1",
          autoSubmitConfig: null,
          composerState: {
            selectedProvider: "codewhale",
            effectiveModeId: "",
            effectiveModelId: null,
            effectiveThinkingOptionId: null,
            providerOptions: undefined,
            metadata: {},
          },
          hostDisconnectedMessage: "disconnected",
          selectModelMessage: "select a model",
        }),
      ).resolves.toEqual({ agentId: result.id, result });

      const request = createAgent.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        workspaceId: "workspace-1",
        initialPrompt: "Investigate this",
      });
      if (parentAgentId) {
        expect(request).toMatchObject({
          callerAgentId: parentAgentId,
          initialPromptOrigin: "user",
        });
      } else {
        expect(request).not.toHaveProperty("callerAgentId");
        expect(request).not.toHaveProperty("initialPromptOrigin");
      }
    },
  );

  test("varies idempotencyKey when callerAgentId changes and trims blank parent ids", async () => {
    const result = {
      id: "created-agent",
      provider: "codewhale",
      cwd: "/tmp/project",
      model: null,
      createdAt: "",
      updatedAt: "",
      lastUserMessageAt: null,
      status: "idle" as const,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: false,
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
      labels: {},
    };
    const createAgent = vi.fn<DaemonClient["createAgent"]>().mockResolvedValue(result);
    const submit = (parentAgentId: string | null) =>
      submitDraftCreateRequest({
        draftId: "draft-1",
        parentAgentId,
        attempt: { clientMessageId: "message-1" },
        text: "Investigate this",
        cwd: "/tmp/project",
        client: { createAgent },
        workspaceDirectory: "/tmp/project",
        workspaceId: "workspace-1",
        autoSubmitConfig: null,
        composerState: {
          selectedProvider: "codewhale",
          effectiveModeId: "",
          effectiveModelId: null,
          effectiveThinkingOptionId: null,
          providerOptions: undefined,
          metadata: {},
        },
        hostDisconnectedMessage: "disconnected",
        selectModelMessage: "select a model",
      });

    await submit("  parent-1  ");
    await submit("parent-2");
    await submit("   ");

    const first = createAgent.mock.calls[0]?.[0];
    const second = createAgent.mock.calls[1]?.[0];
    const third = createAgent.mock.calls[2]?.[0];
    expect(first?.callerAgentId).toBe("parent-1");
    expect(second?.callerAgentId).toBe("parent-2");
    expect(third).not.toHaveProperty("callerAgentId");
    expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
    expect(first?.idempotencyKey).not.toBe(third?.idempotencyKey);
  });

  test("resets read-only mode and Main Control restrictions when spawning from Main Control", () => {
    const mainCodexSetup = buildSubagentDraftSetup(
      {
        provider: "codex",
        cwd: "/tmp/project",
        currentModeId: "read-only",
        model: "gpt-5",
        thinkingOptionId: "high",
        options: {
          sandbox_mode: "read-only",
          approval_policy: "never",
          service_tier: "priority",
        },
        labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
      },
      " main-1 ",
    );
    expect(mainCodexSetup).toEqual({
      provider: "codex",
      cwd: "/tmp/project",
      modeId: null,
      model: "gpt-5",
      thinkingOptionId: "high",
      providerOptions: { service_tier: "priority" },
      parentAgentId: "main-1",
    });

    const mainClaudeSetup = buildSubagentDraftSetup(
      {
        provider: "claude",
        cwd: "/tmp/project",
        currentModeId: "default",
        model: "claude-sonnet",
        thinkingOptionId: null,
        options: {
          disallowedTools: ["WebFetch", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"],
        },
        labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
      },
      "main-2",
    );
    expect(mainClaudeSetup?.providerOptions).toEqual({ disallowedTools: ["WebFetch"] });

    const regularReadOnlySetup = buildSubagentDraftSetup(
      {
        provider: "codex",
        cwd: "/tmp/project",
        currentModeId: "read-only",
        model: "gpt-5",
        thinkingOptionId: null,
        options: { sandbox_mode: "read-only" },
        labels: {},
      },
      "lead-1",
    );
    expect(regularReadOnlySetup?.modeId).toBe("read-only");
    expect(regularReadOnlySetup?.providerOptions).toEqual({ sandbox_mode: "read-only" });
  });

  test("prefills after hydration once and leaves an edited draft alone", () => {
    const initialDraftText = "> Selected text\n> Second line\n\n";
    let text = "";
    const textSource = { getSnapshot: () => text };
    const replaceDraftText = vi.fn((nextText: string) => {
      text = nextText;
    });
    const onInitialized = vi.fn();
    const { rerender } = renderHook(
      ({ draftKey, isHydrated }) =>
        useInitialDraftText({
          draftKey,
          initialDraftText,
          isHydrated,
          textSource,
          replaceDraftText,
          onInitialized,
        }),
      { initialProps: { draftKey: "draft-1", isHydrated: false } },
    );

    expect(replaceDraftText).not.toHaveBeenCalled();
    expect(onInitialized).not.toHaveBeenCalled();
    rerender({ draftKey: "draft-1", isHydrated: true });
    expect(replaceDraftText).toHaveBeenCalledExactlyOnceWith(initialDraftText);
    text = "";
    rerender({ draftKey: "draft-1", isHydrated: false });
    rerender({ draftKey: "draft-1", isHydrated: true });
    expect(text).toBe("");
    expect(onInitialized).toHaveBeenCalledTimes(1);

    text = "Saved draft";
    rerender({ draftKey: "draft-2", isHydrated: true });
    expect(text).toBe("Saved draft");
    expect(replaceDraftText).toHaveBeenCalledTimes(1);
  });
});

describe("workspace tab lifecycle", () => {
  test.each([
    ["destination", false],
    [" source ", true],
  ] as const)(
    "rechecks whether to archive when clearing the label detaches the agent in %j",
    async (nextWorkspaceId, shouldArchive) => {
      const serverId = "close-subagent-host";
      const store = useSessionStore.getState();
      const child = { id: "child", parentAgentId: "parent", workspaceId: "source" } as Agent;
      store.initializeSession(serverId, null as unknown as DaemonClient);
      const setChild = (agent: Agent) =>
        store.setAgents(
          serverId,
          new Map([
            [
              agent.id,
              {
                ...agent,
                pendingPermissions: [],
                turn: { phase: "idle", cancellationRequestId: null },
                status: "idle",
                updatedAt: new Date(0),
              },
            ],
          ]),
        );
      setChild(child);
      const updateStarted = Promise.withResolvers<void>();
      const updateFinished = Promise.withResolvers<void>();
      const updateAgent = vi.fn<DaemonClient["updateAgent"]>(() => {
        updateStarted.resolve();
        return updateFinished.promise;
      });
      try {
        const close = clearSubagentOpenTabLabel({
          client: { updateAgent },
          agentId: child.id,
          serverId,
          workspaceId: "source",
        });
        await updateStarted.promise;
        setChild({ ...child, parentAgentId: null, workspaceId: nextWorkspaceId });
        updateFinished.resolve();
        await expect(close).resolves.toBe(shouldArchive);
        const label = getOpenAgentTabLabel(await getOrCreateClientId());
        expect(updateAgent).toHaveBeenCalledExactlyOnceWith(child.id, {
          labels: { [label]: "false" },
        });
      } finally {
        store.clearSession(serverId);
      }
    },
  );

  test("blocks draft close only while creation is active", () => {
    const draftId = "closing-draft";
    const target = { kind: "draft", draftId } as const;
    const store = useCreateFlowStore.getState();
    expect(isDraftTabSubmitting(target)).toBe(false);
    store.setPending({
      draftId,
      serverId: "host",
      agentId: null,
      clientMessageId: "message",
      text: "hello",
      timestamp: 0,
    });
    try {
      expect(isDraftTabSubmitting(target)).toBe(true);
      store.markLifecycle({ draftId, lifecycle: "abandoned" });
      expect(isDraftTabSubmitting(target)).toBe(false);
    } finally {
      store.clear({ draftId });
    }
  });

  test.each(["split-panes", "compact"] as const)(
    "opens the created subagent as a tab if its draft is gone (%s)",
    (layoutMode) => {
      const serverId = "retarget-draft-host";
      const workspaceId = "retargeted-draft";
      const workspaceKey = `${serverId}:${workspaceId}`;
      const state = useWorkspaceLayoutStore.getState();
      const target = { kind: "agent", agentId: "created-agent" } as const;
      const store = useSessionStore.getState();
      store.initializeSession(serverId, null as unknown as DaemonClient);
      const child = { id: target.agentId, parentAgentId: "parent", workspaceId } as Agent;
      store.setAgentDetails(serverId, new Map([[child.id, child]]));
      try {
        state.setLayoutMode(layoutMode);
        const draftTabId = state.openTab({
          workspaceKey,
          target: { kind: "draft", draftId: "closed-draft" },
          intent: "new",
        });
        if (!draftTabId) throw new Error("Expected a draft tab");
        state.closeTab(workspaceKey, draftTabId);
        expect(state.replaceTab(workspaceKey, draftTabId, target)).toBeNull();
        revealCreatedDraftAgentTab({
          workspaceKey,
          target,
          preferences: DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES,
        });
        expect(state.getWorkspaceTabs(workspaceKey).map((tab) => tab.target)).toContainEqual(
          target,
        );
      } finally {
        useWorkspaceLayoutStore.setState(state);
        store.clearSession(serverId);
      }
    },
  );

  test("keeps provider subagent tabs until the parent list loads, then removes orphaned tabs", () => {
    const store = createWorkspaceLayoutStore().getState();
    const workspaceKey = "host:provider-subagent-tabs";
    const open = (parentAgentId: string) =>
      store.openTab({
        workspaceKey,
        target: {
          kind: "provider_subagent",
          parentAgentId,
          subagentId: `subagent-${parentAgentId}`,
        },
        intent: "new",
      });
    const local = open("local");
    const moved = open("moved");
    const snapshot = {
      activeAgentIds: ["local"],
      autoOpenAgentIds: [],
      standaloneTerminalIds: [],
      terminalsHydrated: true,
    };
    const providerTabs = () =>
      store
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "provider_subagent")
        .map((tab) => tab.tabId);
    store.reconcileTabs(workspaceKey, { ...snapshot, agentsHydrated: false });
    expect(providerTabs()).toEqual([local, moved]);
    store.reconcileTabs(workspaceKey, { ...snapshot, agentsHydrated: true });
    expect(providerTabs()).toEqual([local]);
  });
});

describe("AssistantForkMenu depth gating", () => {
  test("shows Fork as subagent first only when AllowSubagentForkContext is true", () => {
    const onFork = vi.fn();
    const { unmount } = render(
      createElement(
        AllowSubagentForkContext.Provider,
        { value: true },
        createElement(AssistantForkMenu, { onFork, testID: "fork-allowed" }),
      ),
    );
    fireEvent.click(screen.getByTestId("fork-allowed-trigger"));
    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toBe(screen.getByTestId("fork-allowed-subagent"));
    fireEvent.click(screen.getByTestId("fork-allowed-subagent"));
    expect(onFork).toHaveBeenCalledExactlyOnceWith("subagent");
    unmount();

    const { unmount: unmountHidden } = render(
      createElement(
        AllowSubagentForkContext.Provider,
        { value: false },
        createElement(AssistantForkMenu, { onFork, testID: "fork-hidden" }),
      ),
    );
    fireEvent.click(screen.getByTestId("fork-hidden-trigger"));
    expect(screen.queryByTestId("fork-hidden-subagent")).toBeNull();
    expect(screen.getByTestId("fork-hidden-new-tab")).toBeTruthy();
    expect(screen.getByTestId("fork-hidden-new-workspace")).toBeTruthy();
    unmountHidden();
  });
});

describe("selection right click menu", () => {
  test("opens a subagent action and preserves native menus on unselected targets", () => {
    const streamRef = createRef<HTMLDivElement>();
    const spawn = vi.fn();
    const { unmount } = render(
      createElement(
        "div",
        { ref: streamRef },
        createElement("p", { "data-testid": "assistant-message" }, "Investigate this"),
        createElement("a", { "data-testid": "other-link", href: "https://example.com" }, "Docs"),
        createElement("input", { "data-testid": "other-input" }),
        createElement(AssistantSelectionQuote, { streamRef, onSpawnSubagentFromSelection: spawn }),
      ),
    );
    const message = screen.getByTestId("assistant-message");
    const otherLink = screen.getByTestId("other-link");
    const otherInput = screen.getByTestId("other-input");
    const contextMenu = (target: Element) =>
      fireEvent.contextMenu(target, { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
    const selection = window.getSelection();
    if (!selection) throw new Error("Expected a browser selection");
    selection.removeAllRanges();
    expect(contextMenu(message)).toBe(true);
    expect(contextMenu(otherLink)).toBe(true);
    expect(contextMenu(otherInput)).toBe(true);
    expect(screen.queryByTestId("assistant-selection-context-menu")).toBeNull();

    const range = document.createRange();
    range.selectNodeContents(message);
    selection.addRange(range);
    // Unselected link/input outside the selected passage remain untouched for native menus.
    expect(contextMenu(otherLink)).toBe(true);
    expect(contextMenu(otherInput)).toBe(true);
    expect(screen.queryByTestId("assistant-selection-context-menu")).toBeNull();

    expect(contextMenu(message)).toBe(false);
    fireEvent.click(screen.getByTestId("assistant-selection-context-menu-subagent"));
    expect(spawn).toHaveBeenCalledExactlyOnceWith("Investigate this");
    expect(screen.queryByTestId("assistant-selection-context-menu")).toBeNull();
    selection.removeAllRanges();
    unmount();
  });

  test("preserves quote and copy while hiding subagent action at depth limit and dismisses on Escape or outside pointerdown", () => {
    const streamRef = createRef<HTMLDivElement>();
    const onQuote = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { unmount } = render(
      createElement(
        "div",
        { ref: streamRef },
        createElement("p", { "data-testid": "assistant-message" }, "Selected snippet"),
        createElement("div", { "data-testid": "outside-area" }, "Outside"),
        createElement(AssistantSelectionQuote, { streamRef, onQuote }),
      ),
    );
    const message = screen.getByTestId("assistant-message");
    const outside = screen.getByTestId("outside-area");
    const selection = window.getSelection();
    if (!selection) throw new Error("Expected a browser selection");
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(message);
    selection.addRange(range);

    // Open menu -> subagent hidden, quote and copy visible -> dismiss via Escape.
    expect(
      fireEvent.contextMenu(message, { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    ).toBe(false);
    expect(screen.queryByTestId("assistant-selection-context-menu-subagent")).toBeNull();
    expect(screen.getByTestId("assistant-selection-context-menu-quote")).toBeTruthy();
    expect(screen.getByTestId("assistant-selection-context-menu-copy")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("assistant-selection-context-menu")).toBeNull();

    // Open menu -> dismiss via outside pointerdown.
    expect(
      fireEvent.contextMenu(message, { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    ).toBe(false);
    expect(screen.getByTestId("assistant-selection-context-menu")).toBeTruthy();
    fireEvent.pointerDown(outside);
    expect(screen.queryByTestId("assistant-selection-context-menu")).toBeNull();

    // Open menu -> click Copy -> writes captured text and stays dismissed without reopening pill.
    expect(
      fireEvent.contextMenu(message, { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    ).toBe(false);
    const copyItem = screen.getByTestId("assistant-selection-context-menu-copy");
    fireEvent.pointerDown(copyItem);
    fireEvent.pointerUp(copyItem);
    fireEvent.click(copyItem);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Selected snippet");
    expect(screen.queryByTestId("assistant-selection-context-menu")).toBeNull();
    expect(screen.queryByTestId("assistant-selection-quote")).toBeNull();

    // Changing the selection after right-click must not change the captured quote.
    try {
      expect(
        fireEvent.contextMenu(message, {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      ).toBe(false);
      selection.removeAllRanges();
      const outsideRange = document.createRange();
      outsideRange.selectNodeContents(outside);
      selection.addRange(outsideRange);
      fireEvent.click(screen.getByTestId("assistant-selection-context-menu-quote"));
      expect(onQuote).toHaveBeenCalledExactlyOnceWith({ quote: "Selected snippet" });
      expect(selection.rangeCount).toBe(0);
      expect(screen.queryByTestId("assistant-selection-context-menu")).toBeNull();
      expect(screen.queryByTestId("assistant-selection-quote-note")).toBeNull();
    } finally {
      selection.removeAllRanges();
      unmount();
    }
  });

  test.each(["click", "Enter"])("adds a floating quote directly on %s", async (action) => {
    const streamRef = createRef<HTMLDivElement>();
    const onQuote = vi.fn();
    const originalGetClientRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = () =>
      [{ left: 10, top: 20, width: 80, height: 18 }] as unknown as DOMRectList;
    const { unmount } = render(
      createElement(
        "div",
        { ref: streamRef },
        createElement("p", { "data-testid": "assistant-message" }, "Selected snippet"),
        createElement(AssistantSelectionQuote, { streamRef, onQuote }),
      ),
    );
    const selection = window.getSelection();
    if (!selection) throw new Error("Expected a browser selection");
    try {
      const message = screen.getByTestId("assistant-message");
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(message);
      selection.addRange(range);
      fireEvent(document, new Event("selectionchange"));
      const pill = await screen.findByTestId("assistant-selection-quote");

      if (action === "click") {
        const button = pill.querySelector("button, [role='button']");
        if (!button) throw new Error("Expected a quote button");
        fireEvent.click(button);
      } else {
        expect(fireEvent.keyDown(window, { key: "Enter" })).toBe(false);
        expect(fireEvent.keyDown(window, { key: "Enter", repeat: true })).toBe(false);
        fireEvent.keyUp(window, { key: "Enter" });
        expect(fireEvent.keyDown(window, { key: "Enter" })).toBe(true);
      }

      expect(onQuote).toHaveBeenCalledExactlyOnceWith({ quote: "Selected snippet" });
      expect(selection.rangeCount).toBe(0);
      expect(screen.queryByTestId("assistant-selection-quote")).toBeNull();
      expect(screen.queryByTestId("assistant-selection-quote-note")).toBeNull();
    } finally {
      fireEvent.keyUp(window, { key: "Enter" });
      Range.prototype.getClientRects = originalGetClientRects;
      selection.removeAllRanges();
      unmount();
    }
  });
});
