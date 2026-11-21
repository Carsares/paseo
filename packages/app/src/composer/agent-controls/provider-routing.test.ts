import { describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  resolveSelectedModelLabel,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import {
  resolveAgentControlsProfileProviders,
  resolveAgentControlsSelectorProviders,
  routeAgentModelSelection,
} from "./provider-routing";

const codex: ProviderSnapshotEntry = {
  provider: "codex",
  enabled: true,
  status: "ready",
  models: [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4" }],
};
const claude: ProviderSnapshotEntry = {
  provider: "claude",
  enabled: true,
  status: "ready",
  models: [{ provider: "claude", id: "sonnet", label: "Sonnet" }],
};
const loading: ProviderSnapshotEntry = { provider: "pi", enabled: true, status: "loading" };
const disabled: ProviderSnapshotEntry = { provider: "copilot", enabled: false, status: "ready" };
const unavailable: ProviderSnapshotEntry = {
  provider: "opencode",
  enabled: true,
  status: "unavailable",
};
const fallbackProviders: ProviderSelectorProvider[] = [
  { id: "codex", label: "codex", modelSelection: { kind: "loading" } },
];
const selectorInput = {
  canSwitchProvider: true,
  agentProvider: "codex",
  snapshotEntries: [claude, codex, loading, disabled, unavailable],
  snapshotSelectedEntry: codex,
  fallbackProviders,
  isConnected: true,
};

describe("resolveAgentControlsSelectorProviders", () => {
  it("shows only the active provider when switching is unavailable", () => {
    const providers = resolveAgentControlsSelectorProviders({
      ...selectorInput,
      canSwitchProvider: false,
    });
    expect(providers.map((provider) => provider.id)).toEqual(["codex"]);
  });

  it("shows enabled providers and turns an unfinished catalog into an error when disconnected", () => {
    const providers = resolveAgentControlsSelectorProviders({
      ...selectorInput,
      isConnected: false,
    });
    expect(providers.map(({ id, modelSelection }) => [id, modelSelection.kind])).toEqual([
      ["claude", "models"],
      ["codex", "models"],
      ["pi", "error"],
      ["opencode", "error"],
    ]);
  });

  it("keeps the active model label when its provider has been disabled", () => {
    const disabledCodex = { ...codex, enabled: false };
    const providers = resolveAgentControlsSelectorProviders({
      ...selectorInput,
      snapshotEntries: [claude, disabledCodex, disabled],
      snapshotSelectedEntry: disabledCodex,
    });
    expect(providers.map((provider) => provider.id)).toEqual(["codex", "claude"]);
    expect(
      resolveSelectedModelLabel({
        providers,
        selectedProvider: "codex",
        selectedModel: "gpt-5.4",
        isLoading: false,
      }),
    ).toBe("GPT-5.4");
  });

  it("keeps the active provider while the catalog loads", () => {
    expect(
      resolveAgentControlsSelectorProviders({
        ...selectorInput,
        snapshotEntries: undefined,
        snapshotSelectedEntry: null,
      }),
    ).toEqual(fallbackProviders);
  });
});

describe("resolveAgentControlsProfileProviders", () => {
  it("offers profiles for the active provider only when switching is unavailable", () => {
    expect(
      resolveAgentControlsProfileProviders({ ...selectorInput, canSwitchProvider: false }),
    ).toEqual(["codex"]);
  });

  it("offers profiles for enabled, ready providers without duplicating the active provider", () => {
    expect(resolveAgentControlsProfileProviders(selectorInput)).toEqual(["claude", "codex"]);
  });

  it("keeps the active provider eligible when disabled or missing from the catalog", () => {
    expect(
      resolveAgentControlsProfileProviders({
        ...selectorInput,
        snapshotEntries: [claude, { ...codex, enabled: false }],
      }),
    ).toEqual(["claude", "codex"]);
    expect(
      resolveAgentControlsProfileProviders({ ...selectorInput, snapshotEntries: undefined }),
    ).toEqual(["codex"]);
  });
});

function modelSelectionActions(didSwitch = true) {
  return {
    selectSameProviderModel: vi.fn(async () => {}),
    handoffToProvider: vi.fn(async () => didSwitch),
    persistCrossProviderModelPreference: vi.fn(async () => {}),
  };
}

describe("routeAgentModelSelection", () => {
  it.each(["codex", " codex ", " "])(
    "uses the live model control for provider %j",
    async (provider) => {
      const actions = modelSelectionActions();
      await routeAgentModelSelection({
        currentProvider: "codex",
        nextProvider: provider,
        modelId: "gpt-5.4",
        ...actions,
      });
      expect(actions.selectSameProviderModel).toHaveBeenCalledExactlyOnceWith("gpt-5.4");
      expect(actions.handoffToProvider).not.toHaveBeenCalled();
      expect(actions.persistCrossProviderModelPreference).not.toHaveBeenCalled();
    },
  );

  it("saves the destination model preference after the handoff succeeds", async () => {
    const actions = modelSelectionActions();
    const selection = routeAgentModelSelection({
      currentProvider: "codex",
      nextProvider: " claude ",
      modelId: "sonnet",
      ...actions,
    });
    expect(actions.persistCrossProviderModelPreference).not.toHaveBeenCalled();
    await selection;
    expect(actions.handoffToProvider).toHaveBeenCalledExactlyOnceWith({
      provider: "claude",
      modelId: "sonnet",
    });
    expect(actions.persistCrossProviderModelPreference).toHaveBeenCalledExactlyOnceWith(
      "claude",
      "sonnet",
    );
    expect(actions.selectSameProviderModel).not.toHaveBeenCalled();
  });

  it("leaves preferences alone when the handoff does not switch the provider", async () => {
    const actions = modelSelectionActions(false);
    await routeAgentModelSelection({
      currentProvider: "codex",
      nextProvider: "claude",
      modelId: "sonnet",
      ...actions,
    });
    expect(actions.handoffToProvider).toHaveBeenCalledExactlyOnceWith({
      provider: "claude",
      modelId: "sonnet",
    });
    expect(actions.persistCrossProviderModelPreference).not.toHaveBeenCalled();
    expect(actions.selectSameProviderModel).not.toHaveBeenCalled();
  });

  it("ignores a stale Command Center selection for another provider when switching is unavailable", async () => {
    const { selectSameProviderModel, persistCrossProviderModelPreference } =
      modelSelectionActions();
    await routeAgentModelSelection({
      currentProvider: "codex",
      nextProvider: "claude",
      modelId: "sonnet",
      selectSameProviderModel,
      persistCrossProviderModelPreference,
    });
    expect(selectSameProviderModel).not.toHaveBeenCalled();
    expect(persistCrossProviderModelPreference).not.toHaveBeenCalled();
  });

  it("ignores selections until the current agent provider is known", async () => {
    const actions = modelSelectionActions();
    await routeAgentModelSelection({
      currentProvider: undefined,
      nextProvider: "claude",
      modelId: "sonnet",
      ...actions,
    });
    expect(actions.selectSameProviderModel).not.toHaveBeenCalled();
    expect(actions.handoffToProvider).not.toHaveBeenCalled();
    expect(actions.persistCrossProviderModelPreference).not.toHaveBeenCalled();
  });
});
