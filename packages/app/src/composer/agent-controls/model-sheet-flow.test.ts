import { describe, expect, it, vi } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { topicWorkbench } from "@/i18n/domains/topic-workbench";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import {
  buildCrossProviderHandoffSelection,
  buildCrossProviderSwitchDisclosurePlan,
  confirmCrossProviderSwitchFlow,
  hasBlankContextSwitchPermissions,
  isAgentTurnRunning,
  precheckModelThinkingCompatibility,
  readLiveTopicMetadataDisclosure,
  resolveCrossProviderOutboundItems,
  resolveModelSheetOpening,
  toggleWorkspaceBatchModel,
  type CrossProviderSwitchHandoffSelection,
  type CrossProviderSwitchTarget,
  type LiveAgentSwitchSnapshot,
  type TopicMetadataDisclosureState,
} from "./model-sheet-flow";

function provider(id: string, label: string): ProviderSelectorProvider {
  return { id, label, modelSelection: { kind: "models", rows: [] } };
}

const codex = provider("codex", "Codex");
const claude = provider("claude", "Claude Code");

const modelWithThinking: AgentModelDefinition = {
  provider: "claude",
  id: "claude-sonnet",
  label: "Sonnet",
  thinkingOptions: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ],
  defaultThinkingOptionId: "medium",
};

const modelWithoutThinking: AgentModelDefinition = {
  provider: "claude",
  id: "claude-fast",
  label: "Fast",
};

describe("model sheet opening", () => {
  it("starts drafts at providers even when only one provider is available", () => {
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: true,
        providers: [codex],
        selectedProvider: "codex",
      }),
    ).toEqual({ kind: "all" });
  });

  it("opens a running agent directly at its fixed provider", () => {
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: false,
        providers: [claude, codex],
        selectedProvider: "codex",
      }),
    ).toEqual({ kind: "provider", providerId: "codex", providerLabel: "Codex" });
  });

  it("falls back to the only provider while live state catches up", () => {
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: false,
        providers: [codex],
        selectedProvider: "",
      }),
    ).toEqual({ kind: "provider", providerId: "codex", providerLabel: "Codex" });
  });
});

it("caps the list at four, distinguishes providers, and lets users remove a selected model at the cap", () => {
  const models = [codex, claude, provider("pi", "Pi"), provider("muse", "Muse")].map(
    ({ id, label }) => ({
      provider: id,
      providerLabel: label,
      modelId: "default",
      modelLabel: "Default",
    }),
  );
  const fifth = { ...models[0]!, modelId: "another" };
  expect(toggleWorkspaceBatchModel({ models: models.slice(0, 3), model: models[3]! })).toEqual(
    models,
  );
  expect(toggleWorkspaceBatchModel({ models, model: fifth })).toBeNull();
  expect(toggleWorkspaceBatchModel({ models, model: models[1]! })).toEqual([
    models[0],
    models[2],
    models[3],
  ]);
  expect(toggleWorkspaceBatchModel({ models: [], model: fifth, disabled: true })).toBeNull();
});

describe("precheckModelThinkingCompatibility", () => {
  it("clears incompatible thinking settings when switching to a model without thinking options", () => {
    expect(
      precheckModelThinkingCompatibility({
        targetModel: modelWithoutThinking,
        currentThinkingOptionId: "xhigh",
      }),
    ).toEqual({ kind: "clear", previousThinkingOptionId: "xhigh" });

    expect(
      precheckModelThinkingCompatibility({
        targetModel: modelWithoutThinking,
        currentThinkingOptionId: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("keeps compatible thinking options unchanged", () => {
    expect(
      precheckModelThinkingCompatibility({
        targetModel: modelWithThinking,
        currentThinkingOptionId: "high",
      }),
    ).toEqual({ kind: "none" });
  });

  it("adjusts incompatible thinking options to saved preference first, then target model default", () => {
    expect(
      precheckModelThinkingCompatibility({
        targetModel: modelWithThinking,
        currentThinkingOptionId: "xhigh",
        savedThinkingOptionId: "low",
      }),
    ).toEqual({
      kind: "adjust",
      thinkingOptionId: "low",
      thinkingLabel: "Low",
      previousThinkingOptionId: "xhigh",
    });

    expect(
      precheckModelThinkingCompatibility({
        targetModel: modelWithThinking,
        currentThinkingOptionId: "xhigh",
        savedThinkingOptionId: "unsupported",
      }),
    ).toEqual({
      kind: "adjust",
      thinkingOptionId: "medium",
      thinkingLabel: "Medium",
      previousThinkingOptionId: "xhigh",
    });
  });

  it("does nothing when the target model definition is unavailable", () => {
    expect(
      precheckModelThinkingCompatibility({
        targetModel: null,
        currentThinkingOptionId: "high",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("cross-provider switch disclosure plan", () => {
  it("marks silent seats as config-only without handoff summary and still discloses main task ledger", () => {
    const plan = buildCrossProviderSwitchDisclosurePlan({
      sourceProvider: "codex",
      sourceProviderLabel: "Codex",
      targetProvider: "claude",
      targetProviderLabel: "Claude Code",
      targetModelId: "claude-fast",
      targetModelLabel: "Fast",
      targetModel: modelWithoutThinking,
      currentThinkingOptionId: "high",
      agentStatus: "closed",
      turnPhase: "idle",
      hasConversationHistory: false,
      topicMetadataState: { status: "present", hideFromModel: true },
      hasWorkspaceTaskLedger: true,
      hasRolePrompt: true,
      pendingPermissionsCount: 0,
      supportsAtomicBlankContextSwitch: true,
    });

    expect(plan.isSilentSeat).toBe(true);
    expect(plan.isRunning).toBe(false);
    expect(plan.defaultContextMode).toBe("fresh-blank");
    expect(plan.canChooseFreshBlank).toBe(false);
    expect(plan.thinkingPrecheck).toEqual({ kind: "clear", previousThinkingOptionId: "high" });
    expect(resolveCrossProviderOutboundItems(plan, "fresh-blank")).toEqual([
      "blank-only",
      "topic-hidden",
      "task-ledger",
      "role-prompt",
    ]);
  });

  it("hides fresh-blank choice when host lacks an atomic blank-context switch contract", () => {
    const plan = buildCrossProviderSwitchDisclosurePlan({
      sourceProvider: "codex",
      sourceProviderLabel: "Codex",
      targetProvider: "claude",
      targetProviderLabel: "Claude Code",
      targetModelId: "claude-sonnet",
      targetModelLabel: "Sonnet",
      targetModel: modelWithThinking,
      currentThinkingOptionId: "medium",
      agentStatus: "idle",
      turnPhase: "idle",
      hasConversationHistory: true,
      topicMetadataState: { status: "none" },
      hasWorkspaceTaskLedger: false,
      hasRolePrompt: false,
      pendingPermissionsCount: 0,
      supportsAtomicBlankContextSwitch: false,
    });

    expect(plan.isSilentSeat).toBe(false);
    expect(plan.canChooseFreshBlank).toBe(false);
    expect(plan.defaultContextMode).toBe("carry-summary");
    expect(resolveCrossProviderOutboundItems(plan, "carry-summary")).toEqual(["handoff-summary"]);
  });

  it("discloses workspace task ledger in both carry-summary and fresh-blank modes on main control", () => {
    const plan = buildCrossProviderSwitchDisclosurePlan({
      sourceProvider: "codex",
      sourceProviderLabel: "Codex",
      targetProvider: "claude",
      targetProviderLabel: "Claude Code",
      targetModelId: "claude-sonnet",
      targetModelLabel: "Sonnet",
      targetModel: modelWithThinking,
      currentThinkingOptionId: "xhigh",
      agentStatus: "running",
      turnPhase: "open",
      hasConversationHistory: true,
      topicMetadataState: { status: "present", hideFromModel: false },
      hasWorkspaceTaskLedger: true,
      hasRolePrompt: true,
      pendingPermissionsCount: 2,
      supportsAtomicBlankContextSwitch: true,
    });

    expect(plan.isSilentSeat).toBe(false);
    expect(plan.isRunning).toBe(true);
    expect(plan.pendingPermissionsCount).toBe(2);
    expect(plan.canChooseFreshBlank).toBe(true);
    expect(plan.defaultContextMode).toBe("carry-summary");
    expect(plan.thinkingPrecheck).toEqual({
      kind: "adjust",
      thinkingOptionId: "medium",
      thinkingLabel: "Medium",
      previousThinkingOptionId: "xhigh",
    });

    expect(resolveCrossProviderOutboundItems(plan, "carry-summary")).toEqual([
      "handoff-summary",
      "topic-metadata",
      "task-ledger",
      "role-prompt",
    ]);
    expect(resolveCrossProviderOutboundItems(plan, "fresh-blank")).toEqual([
      "blank-only",
      "topic-metadata",
      "task-ledger",
      "role-prompt",
    ]);
  });

  it("gates blank-context switch permissions on both workspace.write and hub.execute", () => {
    expect(hasBlankContextSwitchPermissions(undefined)).toBe(true);
    expect(hasBlankContextSwitchPermissions(["workspace.write"])).toBe(false);
    expect(hasBlankContextSwitchPermissions(["hub.execute"])).toBe(false);
    expect(hasBlankContextSwitchPermissions(["workspace.write", "hub.execute"])).toBe(true);
  });

  it("discloses unverified topic metadata conservatively and keeps profile thinking precheck neutral", () => {
    const plan = buildCrossProviderSwitchDisclosurePlan({
      sourceProvider: "codex",
      sourceProviderLabel: "Codex",
      targetProvider: "claude",
      targetProviderLabel: "Claude Code",
      targetModelId: "claude-sonnet",
      targetModelLabel: "Sonnet",
      targetModel: modelWithThinking,
      currentThinkingOptionId: "xhigh",
      skipThinkingPrecheck: true,
      agentStatus: "idle",
      turnPhase: "idle",
      hasConversationHistory: true,
      topicMetadataState: { status: "unverified" },
      hasWorkspaceTaskLedger: true,
      hasRolePrompt: true,
      pendingPermissionsCount: 0,
      supportsAtomicBlankContextSwitch: true,
    });

    expect(plan.thinkingPrecheck).toEqual({ kind: "none" });
    expect(resolveCrossProviderOutboundItems(plan, "carry-summary")).toEqual([
      "handoff-summary",
      "topic-unverified",
      "task-ledger",
      "role-prompt",
    ]);
  });
});

describe("live topic metadata disclosure and confirm-time re-check", () => {
  it("reads authoritative workspace state on every call and falls back conservatively on error", async () => {
    const findWorkspace = vi
      .fn<(workspaceId: string) => Promise<{ topic?: { hideFromModel?: boolean } | null } | null>>()
      .mockResolvedValueOnce({ topic: { hideFromModel: true } })
      .mockResolvedValueOnce({ topic: { hideFromModel: false } })
      .mockRejectedValueOnce(new Error("host unreachable"));

    await expect(
      readLiveTopicMetadataDisclosure({
        client: { findWorkspace },
        workspaceId: "ws-1",
        isMainControl: true,
        supportsTopic: true,
      }),
    ).resolves.toEqual({ status: "present", hideFromModel: true });

    await expect(
      readLiveTopicMetadataDisclosure({
        client: { findWorkspace },
        workspaceId: "ws-1",
        isMainControl: true,
        supportsTopic: true,
      }),
    ).resolves.toEqual({ status: "present", hideFromModel: false });

    await expect(
      readLiveTopicMetadataDisclosure({
        client: { findWorkspace },
        workspaceId: "ws-1",
        isMainControl: true,
        supportsTopic: true,
      }),
    ).resolves.toEqual({ status: "unverified" });

    expect(findWorkspace).toHaveBeenCalledTimes(3);

    await expect(
      readLiveTopicMetadataDisclosure({
        client: null,
        workspaceId: "ws-1",
        isMainControl: true,
        supportsTopic: true,
      }),
    ).resolves.toEqual({ status: "unverified" });

    await expect(
      readLiveTopicMetadataDisclosure({
        client: { findWorkspace },
        workspaceId: "ws-1",
        isMainControl: false,
        supportsTopic: true,
      }),
    ).resolves.toEqual({ status: "none" });
  });

  const expectedSeat = { serverId: "srv-1", agentId: "agent-1" };

  function makeLiveSnapshot(
    overrides: Partial<LiveAgentSwitchSnapshot> = {},
  ): LiveAgentSwitchSnapshot {
    return {
      serverId: expectedSeat.serverId,
      agentId: expectedSeat.agentId,
      provider: "codex",
      workspaceId: "ws-1",
      isMainControl: true,
      isRoleSeat: true,
      status: "idle",
      turnPhase: "idle",
      hasConversationHistory: true,
      pendingPermissionsCount: 0,
      currentThinkingOptionId: "medium",
      livePermissions: ["workspace.write", "hub.execute"],
      ...overrides,
    };
  }

  function rebuildPlanFromSnapshot(
    snapshot: LiveAgentSwitchSnapshot,
    topicMetadataState: TopicMetadataDisclosureState,
    options: { skipThinkingPrecheck?: boolean; supportsBlankFeature?: boolean } = {},
  ) {
    return buildCrossProviderSwitchDisclosurePlan({
      sourceProvider: snapshot.provider,
      sourceProviderLabel: snapshot.provider,
      targetProvider: "claude",
      targetProviderLabel: "Claude Code",
      targetModelId: "claude-sonnet",
      targetModelLabel: "Sonnet",
      targetModel: modelWithThinking,
      currentThinkingOptionId: snapshot.currentThinkingOptionId,
      skipThinkingPrecheck: options.skipThinkingPrecheck,
      agentStatus: snapshot.status,
      turnPhase: snapshot.turnPhase,
      hasConversationHistory: snapshot.hasConversationHistory,
      topicMetadataState,
      hasWorkspaceTaskLedger: Boolean(snapshot.isMainControl && snapshot.workspaceId),
      hasRolePrompt: snapshot.isRoleSeat,
      pendingPermissionsCount: snapshot.pendingPermissionsCount,
      supportsAtomicBlankContextSwitch:
        (options.supportsBlankFeature ?? true) &&
        hasBlankContextSwitchPermissions(snapshot.livePermissions),
    });
  }

  it("updates disclosure and requires re-confirmation when topic visibility flips from hidden to visible before confirm", async () => {
    const liveSnapshot = makeLiveSnapshot();
    const initialPlan = rebuildPlanFromSnapshot(liveSnapshot, {
      status: "present",
      hideFromModel: true,
    });
    const target: CrossProviderSwitchTarget = {
      kind: "model",
      targetProvider: "claude",
      modelId: "claude-sonnet",
    };
    const handoffToProvider = vi.fn(
      async (_selection: CrossProviderSwitchHandoffSelection) => true,
    );
    const executeModelCarrySummary = vi.fn(async () => {});

    const firstAttempt = await confirmCrossProviderSwitchFlow({
      plan: initialPlan,
      target,
      contextMode: "carry-summary",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => liveSnapshot,
      readLiveTopicMetadata: async (): Promise<TopicMetadataDisclosureState> => ({
        status: "present",
        hideFromModel: false,
      }),
      rebuildPlan: (snapshot, topicState) => rebuildPlanFromSnapshot(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(firstAttempt.status).toBe("disclosure-changed");
    expect(handoffToProvider).not.toHaveBeenCalled();
    expect(executeModelCarrySummary).not.toHaveBeenCalled();
    if (firstAttempt.status !== "disclosure-changed") {
      throw new Error("Expected disclosure-changed result");
    }
    expect(firstAttempt.reason).toBe("topic");
    expect(firstAttempt.updatedPlan.disclosureChangedReason).toBe("topic");
    expect(firstAttempt.updatedPlan.topicMetadataState).toEqual({
      status: "present",
      hideFromModel: false,
    });
    expect(resolveCrossProviderOutboundItems(firstAttempt.updatedPlan, "carry-summary")).toContain(
      "topic-metadata",
    );

    const secondAttempt = await confirmCrossProviderSwitchFlow({
      plan: firstAttempt.updatedPlan,
      target,
      contextMode: "carry-summary",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => liveSnapshot,
      readLiveTopicMetadata: async (): Promise<TopicMetadataDisclosureState> => ({
        status: "present",
        hideFromModel: false,
      }),
      rebuildPlan: (snapshot, topicState) => rebuildPlanFromSnapshot(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(secondAttempt).toEqual({ status: "executed", switched: true });
    expect(executeModelCarrySummary).toHaveBeenCalledExactlyOnceWith("claude", "claude-sonnet");
  });

  it("updates disclosure to conservative unverified state when live host lookup fails at confirm time", async () => {
    const liveSnapshot = makeLiveSnapshot();
    const initialPlan = rebuildPlanFromSnapshot(liveSnapshot, {
      status: "present",
      hideFromModel: true,
    });
    const handoffToProvider = vi.fn(
      async (_selection: CrossProviderSwitchHandoffSelection) => true,
    );
    const executeModelCarrySummary = vi.fn(async () => {});

    const failedLookup = await confirmCrossProviderSwitchFlow({
      plan: initialPlan,
      target: { kind: "model", targetProvider: "claude", modelId: "claude-sonnet" },
      contextMode: "fresh-blank",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => liveSnapshot,
      readLiveTopicMetadata: async (): Promise<TopicMetadataDisclosureState> => ({
        status: "unverified",
      }),
      rebuildPlan: (snapshot, topicState) => rebuildPlanFromSnapshot(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(failedLookup.status).toBe("disclosure-changed");
    expect(handoffToProvider).not.toHaveBeenCalled();
    if (failedLookup.status !== "disclosure-changed") {
      throw new Error("Expected disclosure-changed result");
    }
    expect(resolveCrossProviderOutboundItems(failedLookup.updatedPlan, "fresh-blank")).toContain(
      "topic-unverified",
    );

    const confirmedConservative = await confirmCrossProviderSwitchFlow({
      plan: failedLookup.updatedPlan,
      target: { kind: "model", targetProvider: "claude", modelId: "claude-sonnet" },
      contextMode: "fresh-blank",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => liveSnapshot,
      readLiveTopicMetadata: async (): Promise<TopicMetadataDisclosureState> => ({
        status: "unverified",
      }),
      rebuildPlan: (snapshot, topicState) => rebuildPlanFromSnapshot(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(confirmedConservative).toEqual({ status: "executed", switched: true });
    expect(handoffToProvider).toHaveBeenCalledExactlyOnceWith({
      provider: "claude",
      modelId: "claude-sonnet",
      context: "blank",
    });
    expect("onlyIfSilent" in (handoffToProvider.mock.calls[0]?.[0] ?? {})).toBe(false);
  });

  it("blocks stale silent-seat blank switch when another device completes a first prompt before confirm", async () => {
    const silentSnapshot = makeLiveSnapshot({
      status: "closed",
      turnPhase: "idle",
      hasConversationHistory: false,
    });
    const chattedSnapshot = makeLiveSnapshot({
      status: "idle",
      turnPhase: "idle",
      hasConversationHistory: true,
    });
    const silentPlan = rebuildPlanFromSnapshot(silentSnapshot, {
      status: "present",
      hideFromModel: false,
    });
    expect(silentPlan.isSilentSeat).toBe(true);
    expect(silentPlan.defaultContextMode).toBe("fresh-blank");

    const handoffToProvider = vi.fn(
      async (_selection: CrossProviderSwitchHandoffSelection) => true,
    );
    const executeModelCarrySummary = vi.fn(async () => {});

    const staleConfirm = await confirmCrossProviderSwitchFlow({
      plan: silentPlan,
      target: { kind: "model", targetProvider: "claude", modelId: "claude-sonnet" },
      contextMode: "fresh-blank",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => chattedSnapshot,
      readLiveTopicMetadata: async () => ({ status: "present", hideFromModel: false }),
      rebuildPlan: (snapshot, topicState) => rebuildPlanFromSnapshot(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(staleConfirm.status).toBe("disclosure-changed");
    expect(handoffToProvider).not.toHaveBeenCalled();
    if (staleConfirm.status !== "disclosure-changed") {
      throw new Error("Expected disclosure-changed result");
    }
    expect(staleConfirm.reason).toBe("session");
    expect(staleConfirm.updatedPlan.isSilentSeat).toBe(false);
    expect(staleConfirm.updatedPlan.hasConversationHistory).toBe(true);
    expect(staleConfirm.updatedPlan.defaultContextMode).toBe("carry-summary");
    expect(staleConfirm.updatedPlan.canChooseFreshBlank).toBe(true);
    expect(resolveCrossProviderOutboundItems(staleConfirm.updatedPlan, "carry-summary")).toContain(
      "handoff-summary",
    );

    const reconfirmedBlank = await confirmCrossProviderSwitchFlow({
      plan: staleConfirm.updatedPlan,
      target: { kind: "model", targetProvider: "claude", modelId: "claude-sonnet" },
      contextMode: "fresh-blank",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => chattedSnapshot,
      readLiveTopicMetadata: async () => ({ status: "present", hideFromModel: false }),
      rebuildPlan: (snapshot, topicState) => rebuildPlanFromSnapshot(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(reconfirmedBlank).toEqual({ status: "executed", switched: true });
    expect(handoffToProvider).toHaveBeenCalledExactlyOnceWith({
      provider: "claude",
      modelId: "claude-sonnet",
      context: "blank",
    });
    expect("onlyIfSilent" in (handoffToProvider.mock.calls[0]?.[0] ?? {})).toBe(false);
  });

  it("re-checks store after async topic read so silent-to-running/chatted race during read never resets", async () => {
    const silentSnapshot = makeLiveSnapshot({
      status: "closed",
      turnPhase: "idle",
      hasConversationHistory: false,
    });
    let currentSnapshot = silentSnapshot;
    const silentPlan = rebuildPlanFromSnapshot(silentSnapshot, {
      status: "present",
      hideFromModel: false,
    });
    const handoffToProvider = vi.fn(
      async (_selection: CrossProviderSwitchHandoffSelection) => true,
    );
    const executeModelCarrySummary = vi.fn(async () => {});

    const racedConfirm = await confirmCrossProviderSwitchFlow({
      plan: silentPlan,
      target: { kind: "model", targetProvider: "claude", modelId: "claude-sonnet" },
      contextMode: "fresh-blank",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => currentSnapshot,
      readLiveTopicMetadata: async () => {
        // Another device starts a prompt while topic metadata is in flight.
        currentSnapshot = makeLiveSnapshot({
          status: "running",
          turnPhase: "open",
          hasConversationHistory: true,
        });
        return { status: "present", hideFromModel: false };
      },
      rebuildPlan: (snapshot, topicState) => rebuildPlanFromSnapshot(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(racedConfirm.status).toBe("disclosure-changed");
    expect(handoffToProvider).not.toHaveBeenCalled();
    if (racedConfirm.status !== "disclosure-changed") {
      throw new Error("Expected disclosure-changed result");
    }
    expect(racedConfirm.reason).toBe("session");
    expect(racedConfirm.updatedPlan.isSilentSeat).toBe(false);
    expect(racedConfirm.updatedPlan.isRunning).toBe(true);
    expect(racedConfirm.updatedPlan.hasConversationHistory).toBe(true);

    expect(isAgentTurnRunning(currentSnapshot.status, currentSnapshot.turnPhase)).toBe(true);

    // Once the competing turn finishes, the user can confirm again without reopening the modal.
    currentSnapshot = makeLiveSnapshot({
      status: "idle",
      turnPhase: "idle",
      hasConversationHistory: true,
    });
    expect(isAgentTurnRunning(currentSnapshot.status, currentSnapshot.turnPhase)).toBe(false);

    const settledConfirm = await confirmCrossProviderSwitchFlow({
      plan: racedConfirm.updatedPlan,
      target: { kind: "model", targetProvider: "claude", modelId: "claude-sonnet" },
      contextMode: "carry-summary",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => currentSnapshot,
      readLiveTopicMetadata: async () => ({ status: "present", hideFromModel: false }),
      rebuildPlan: (snapshot, topicState) => rebuildPlanFromSnapshot(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(settledConfirm).toEqual({ status: "executed", switched: true });
    expect(executeModelCarrySummary).toHaveBeenCalledExactlyOnceWith("claude", "claude-sonnet");
  });

  it("rebuilds disclosure when source provider changes and cancels safely when already on target or seat disappears", async () => {
    const initialSnapshot = makeLiveSnapshot({ provider: "codex" });
    const initialPlan = rebuildPlanFromSnapshot(initialSnapshot, {
      status: "present",
      hideFromModel: false,
    });
    const handoffToProvider = vi.fn(
      async (_selection: CrossProviderSwitchHandoffSelection) => true,
    );
    const executeModelCarrySummary = vi.fn(async () => {});

    const sourceChanged = await confirmCrossProviderSwitchFlow({
      plan: initialPlan,
      target: { kind: "model", targetProvider: "claude", modelId: "claude-sonnet" },
      contextMode: "carry-summary",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => makeLiveSnapshot({ provider: "opencode" }),
      readLiveTopicMetadata: async () => ({ status: "present", hideFromModel: false }),
      rebuildPlan: (snapshot, topicState) => rebuildPlanFromSnapshot(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(sourceChanged.status).toBe("disclosure-changed");
    if (sourceChanged.status !== "disclosure-changed") {
      throw new Error("Expected disclosure-changed result");
    }
    expect(sourceChanged.reason).toBe("session");
    expect(sourceChanged.updatedPlan.sourceProvider).toBe("opencode");

    const alreadyTarget = await confirmCrossProviderSwitchFlow({
      plan: initialPlan,
      target: { kind: "model", targetProvider: "claude", modelId: "claude-sonnet" },
      contextMode: "carry-summary",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => makeLiveSnapshot({ provider: "claude" }),
      readLiveTopicMetadata: async () => ({ status: "present", hideFromModel: false }),
      rebuildPlan: (snapshot, topicState) => rebuildPlanFromSnapshot(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });
    expect(alreadyTarget).toEqual({ status: "cancelled", reason: "already-on-target-provider" });

    let liveAfterRead: LiveAgentSwitchSnapshot | null = initialSnapshot;
    const seatRemovedDuringRead = await confirmCrossProviderSwitchFlow({
      plan: initialPlan,
      target: { kind: "model", targetProvider: "claude", modelId: "claude-sonnet" },
      contextMode: "carry-summary",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => liveAfterRead,
      readLiveTopicMetadata: async () => {
        liveAfterRead = null;
        return { status: "present", hideFromModel: false };
      },
      rebuildPlan: (snapshot, topicState) => rebuildPlanFromSnapshot(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });
    expect(seatRemovedDuringRead).toEqual({ status: "cancelled", reason: "seat-changed" });
    expect(handoffToProvider).not.toHaveBeenCalled();
    expect(executeModelCarrySummary).not.toHaveBeenCalled();
  });

  it("sends onlyIfSilent: true exclusively for confirmed silent-seat switches and omits it otherwise", async () => {
    const silentSnapshot = makeLiveSnapshot({
      status: "closed",
      turnPhase: "idle",
      hasConversationHistory: false,
    });
    const silentModelPlan = rebuildPlanFromSnapshot(silentSnapshot, {
      status: "present",
      hideFromModel: false,
    });
    const silentProfilePlan = rebuildPlanFromSnapshot(
      silentSnapshot,
      { status: "present", hideFromModel: false },
      { skipThinkingPrecheck: true },
    );
    const handoffToProvider = vi.fn(
      async (_selection: CrossProviderSwitchHandoffSelection) => true,
    );
    const executeModelCarrySummary = vi.fn(async () => {});

    const silentModelResult = await confirmCrossProviderSwitchFlow({
      plan: silentModelPlan,
      target: { kind: "model", targetProvider: "claude", modelId: "claude-sonnet" },
      contextMode: "fresh-blank",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => silentSnapshot,
      readLiveTopicMetadata: async () => ({ status: "present", hideFromModel: false }),
      rebuildPlan: (snapshot, topicState) => rebuildPlanFromSnapshot(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(silentModelResult).toEqual({ status: "executed", switched: true });
    expect(handoffToProvider).toHaveBeenLastCalledWith({
      provider: "claude",
      modelId: "claude-sonnet",
      context: "blank",
      onlyIfSilent: true,
    });

    const silentProfileResult = await confirmCrossProviderSwitchFlow({
      plan: silentProfilePlan,
      target: {
        kind: "profile",
        targetProvider: "claude",
        modelId: "claude-sonnet",
        modeId: "plan",
        thinkingOptionId: "high",
        providerOptions: { fastMode: true },
      },
      contextMode: "fresh-blank",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => silentSnapshot,
      readLiveTopicMetadata: async () => ({ status: "present", hideFromModel: false }),
      rebuildPlan: (snapshot, topicState) =>
        rebuildPlanFromSnapshot(snapshot, topicState, { skipThinkingPrecheck: true }),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(silentProfileResult).toEqual({ status: "executed", switched: true });
    expect(handoffToProvider).toHaveBeenLastCalledWith({
      provider: "claude",
      modelId: "claude-sonnet",
      modeId: "plan",
      thinkingOptionId: "high",
      providerOptions: { fastMode: true },
      kind: "profile",
      context: "blank",
      onlyIfSilent: true,
    });
  });
});

describe("unified cross-provider profile switch flow", () => {
  const expectedSeat = { serverId: "srv-1", agentId: "agent-1" };
  const profileTarget: CrossProviderSwitchTarget = {
    kind: "profile",
    targetProvider: "claude",
    modelId: "claude-sonnet",
    modeId: "plan",
    thinkingOptionId: "high",
    providerOptions: { fastMode: true, maxTokens: 4096 },
  };

  function makeProfileSnapshot(
    livePermissions: readonly string[] | undefined = ["workspace.write", "hub.execute"],
  ): LiveAgentSwitchSnapshot {
    return {
      serverId: expectedSeat.serverId,
      agentId: expectedSeat.agentId,
      provider: "codex",
      workspaceId: "ws-1",
      isMainControl: true,
      isRoleSeat: true,
      status: "idle",
      turnPhase: "idle",
      hasConversationHistory: true,
      pendingPermissionsCount: 0,
      currentThinkingOptionId: "low",
      livePermissions,
    };
  }

  function buildProfilePlan(
    snapshot: LiveAgentSwitchSnapshot,
    topicMetadataState: TopicMetadataDisclosureState,
    supportsBlankFeature = true,
  ) {
    return buildCrossProviderSwitchDisclosurePlan({
      sourceProvider: snapshot.provider,
      sourceProviderLabel: "Codex",
      targetProvider: "claude",
      targetProviderLabel: "Claude Code",
      targetModelId: "claude-sonnet",
      targetModelLabel: "Sonnet",
      targetModel: modelWithThinking,
      currentThinkingOptionId: snapshot.currentThinkingOptionId,
      skipThinkingPrecheck: true,
      agentStatus: snapshot.status,
      turnPhase: snapshot.turnPhase,
      hasConversationHistory: snapshot.hasConversationHistory,
      topicMetadataState,
      hasWorkspaceTaskLedger: true,
      hasRolePrompt: true,
      pendingPermissionsCount: 0,
      supportsAtomicBlankContextSwitch:
        supportsBlankFeature && hasBlankContextSwitchPermissions(snapshot.livePermissions),
    });
  }

  it("preserves mode, thinking, and provider options in both carry-summary and fresh-blank branches", async () => {
    const carrySelection = buildCrossProviderHandoffSelection(profileTarget, "carry-summary");
    expect(carrySelection).toEqual({
      provider: "claude",
      modelId: "claude-sonnet",
      modeId: "plan",
      thinkingOptionId: "high",
      providerOptions: { fastMode: true, maxTokens: 4096 },
      kind: "profile",
    });
    expect("onlyIfSilent" in carrySelection).toBe(false);

    const blankSelection = buildCrossProviderHandoffSelection(profileTarget, "fresh-blank");
    expect(blankSelection).toEqual({
      provider: "claude",
      modelId: "claude-sonnet",
      modeId: "plan",
      thinkingOptionId: "high",
      providerOptions: { fastMode: true, maxTokens: 4096 },
      kind: "profile",
      context: "blank",
    });
    expect("onlyIfSilent" in blankSelection).toBe(false);

    const silentSelection = buildCrossProviderHandoffSelection(profileTarget, "fresh-blank", {
      onlyIfSilent: true,
    });
    expect(silentSelection).toEqual({
      provider: "claude",
      modelId: "claude-sonnet",
      modeId: "plan",
      thinkingOptionId: "high",
      providerOptions: { fastMode: true, maxTokens: 4096 },
      kind: "profile",
      context: "blank",
      onlyIfSilent: true,
    });

    const handoffToProvider = vi.fn(
      async (_selection: CrossProviderSwitchHandoffSelection) => true,
    );
    const executeModelCarrySummary = vi.fn(async () => {});
    const carrySnapshot = makeProfileSnapshot(["workspace.write"]);
    const carryPlan = buildProfilePlan(carrySnapshot, { status: "present", hideFromModel: false });

    const carryResult = await confirmCrossProviderSwitchFlow({
      plan: carryPlan,
      target: profileTarget,
      contextMode: "carry-summary",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => carrySnapshot,
      readLiveTopicMetadata: async () => ({ status: "present", hideFromModel: false }),
      rebuildPlan: (snapshot, topicState) => buildProfilePlan(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(carryResult).toEqual({ status: "executed", switched: true });
    expect(executeModelCarrySummary).not.toHaveBeenCalled();
    expect(handoffToProvider).toHaveBeenLastCalledWith({
      provider: "claude",
      modelId: "claude-sonnet",
      modeId: "plan",
      thinkingOptionId: "high",
      providerOptions: { fastMode: true, maxTokens: 4096 },
      kind: "profile",
    });
    expect("onlyIfSilent" in (handoffToProvider.mock.calls[0]?.[0] ?? {})).toBe(false);

    const blankSnapshot = makeProfileSnapshot(["workspace.write", "hub.execute"]);
    const blankPlan = buildProfilePlan(blankSnapshot, { status: "present", hideFromModel: false });

    const blankResult = await confirmCrossProviderSwitchFlow({
      plan: blankPlan,
      target: profileTarget,
      contextMode: "fresh-blank",
      expectedSeat,
      canSwitchProvider: true,
      supportsBlankFeature: true,
      readLiveSnapshot: () => blankSnapshot,
      readLiveTopicMetadata: async () => ({ status: "present", hideFromModel: false }),
      rebuildPlan: (snapshot, topicState) => buildProfilePlan(snapshot, topicState),
      handoffToProvider,
      executeModelCarrySummary,
    });

    expect(blankResult).toEqual({ status: "executed", switched: true });
    expect(handoffToProvider).toHaveBeenLastCalledWith({
      provider: "claude",
      modelId: "claude-sonnet",
      modeId: "plan",
      thinkingOptionId: "high",
      providerOptions: { fastMode: true, maxTokens: 4096 },
      kind: "profile",
      context: "blank",
    });
    expect("onlyIfSilent" in (handoffToProvider.mock.calls[1]?.[0] ?? {})).toBe(false);
  });

  it("enforces fresh-blank host feature and joint permission gates for cross-provider profiles", async () => {
    const handoffToProvider = vi.fn(
      async (_selection: CrossProviderSwitchHandoffSelection) => true,
    );
    const executeModelCarrySummary = vi.fn(async () => {});

    const fullPermsSnapshot = makeProfileSnapshot(["workspace.write", "hub.execute"]);
    const noFeaturePlan = buildProfilePlan(
      fullPermsSnapshot,
      { status: "present", hideFromModel: false },
      false,
    );
    await expect(
      confirmCrossProviderSwitchFlow({
        plan: noFeaturePlan,
        target: profileTarget,
        contextMode: "fresh-blank",
        expectedSeat,
        canSwitchProvider: true,
        supportsBlankFeature: false,
        readLiveSnapshot: () => fullPermsSnapshot,
        readLiveTopicMetadata: async () => ({ status: "present", hideFromModel: false }),
        rebuildPlan: (snapshot, topicState) => buildProfilePlan(snapshot, topicState, false),
        handoffToProvider,
        executeModelCarrySummary,
      }),
    ).resolves.toEqual({ status: "blocked", reason: "update-host" });

    const partialPermsSnapshot = makeProfileSnapshot(["workspace.write"]);
    const partialPermsPlan = buildProfilePlan(
      partialPermsSnapshot,
      { status: "present", hideFromModel: false },
      true,
    );
    await expect(
      confirmCrossProviderSwitchFlow({
        plan: partialPermsPlan,
        target: profileTarget,
        contextMode: "fresh-blank",
        expectedSeat,
        canSwitchProvider: true,
        supportsBlankFeature: true,
        readLiveSnapshot: () => partialPermsSnapshot,
        readLiveTopicMetadata: async () => ({ status: "present", hideFromModel: false }),
        rebuildPlan: (snapshot, topicState) => buildProfilePlan(snapshot, topicState, true),
        handoffToProvider,
        executeModelCarrySummary,
      }),
    ).resolves.toEqual({ status: "blocked", reason: "unavailable" });

    expect(handoffToProvider).not.toHaveBeenCalled();
  });

  it("uses conditional hidden-topic disclosure wording and preserves main-control resident roster copy", () => {
    expect(topicWorkbench["zh-CN"].modelSwitch.outboundTopicHidden).not.toContain("不会发送");
    expect(topicWorkbench["zh-CN"].modelSwitch.outboundTopicHidden).toContain("当前隐藏");
    expect(topicWorkbench["zh-CN"].modelSwitch.outboundTopicHidden).toContain("发送时若公开");
    expect(topicWorkbench.en.modelSwitch.outboundTopicHidden).toContain("currently hidden");
    expect(topicWorkbench.en.modelSwitch.outboundTopicHidden).toContain("when you send");
    expect(topicWorkbench["zh-CN"].modelSwitch.outboundRolePrompt).toContain("常驻专员");
    expect(topicWorkbench.en.modelSwitch.outboundRolePrompt).toContain(
      "resident specialist roster",
    );
  });
});
