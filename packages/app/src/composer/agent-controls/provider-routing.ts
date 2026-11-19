import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  buildSelectableProviderSelectorProviders,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";

interface AgentControlsSelectorProvidersInput {
  canSwitchProvider: boolean;
  agentProvider: string | undefined;
  snapshotEntries: ProviderSnapshotEntry[] | undefined;
  snapshotSelectedEntry: ProviderSnapshotEntry | null;
  fallbackProviders: ProviderSelectorProvider[];
  isConnected: boolean;
}

export function resolveAgentControlsSelectorProviders(
  input: AgentControlsSelectorProvidersInput,
): ProviderSelectorProvider[] {
  // Keep the active model's label available even if its provider was disabled.
  const singleProviderList = input.snapshotSelectedEntry
    ? buildSelectableProviderSelectorProviders(
        [{ ...input.snapshotSelectedEntry, enabled: true }],
        input.isConnected,
      )
    : input.fallbackProviders;
  if (!input.canSwitchProvider) {
    return singleProviderList;
  }

  const allSelectable = buildSelectableProviderSelectorProviders(
    input.snapshotEntries,
    input.isConnected,
  );
  if (input.agentProvider && !allSelectable.some((entry) => entry.id === input.agentProvider)) {
    return [...singleProviderList, ...allSelectable];
  }
  return allSelectable;
}

interface AgentControlsProfileProvidersInput {
  canSwitchProvider: boolean;
  agentProvider: string | undefined;
  snapshotEntries: ProviderSnapshotEntry[] | undefined;
}

export function resolveAgentControlsProfileProviders(
  input: AgentControlsProfileProvidersInput,
): string[] {
  const { agentProvider, canSwitchProvider, snapshotEntries } = input;
  if (!canSwitchProvider) {
    return agentProvider ? [agentProvider] : [];
  }

  const providers = new Set(
    (snapshotEntries ?? [])
      .filter((entry) => entry.enabled && entry.status === "ready")
      .map((entry) => entry.provider),
  );
  if (agentProvider) {
    providers.add(agentProvider);
  }
  return [...providers];
}

interface AgentModelSelectionRoutingInput {
  currentProvider: string | undefined;
  nextProvider: AgentProvider;
  modelId: string;
  selectSameProviderModel: (modelId: string) => Promise<void>;
  handoffToProvider: (selection: { provider: AgentProvider; modelId: string }) => Promise<boolean>;
  persistCrossProviderModelPreference: (provider: AgentProvider, modelId: string) => Promise<void>;
}

export async function routeAgentModelSelection(
  input: AgentModelSelectionRoutingInput,
): Promise<void> {
  if (!input.currentProvider) {
    return;
  }

  const targetProvider = input.nextProvider.trim() || input.currentProvider;
  if (targetProvider === input.currentProvider) {
    await input.selectSameProviderModel(input.modelId);
    return;
  }

  const didSwitch = await input.handoffToProvider({
    provider: targetProvider,
    modelId: input.modelId,
  });
  if (didSwitch) {
    await input.persistCrossProviderModelPreference(targetProvider, input.modelId);
  }
}
