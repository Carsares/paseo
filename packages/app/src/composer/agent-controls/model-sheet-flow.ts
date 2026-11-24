import type { ModelBrowserView } from "@/components/model-browser-view";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

export const MAX_WORKSPACE_BATCH_MODELS = 4;

export interface WorkspaceBatchModel {
  provider: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
}

export interface WorkspaceBatchModelPicker {
  models: readonly WorkspaceBatchModel[];
  disabledReason?: string;
  onChange: (models: WorkspaceBatchModel[]) => void;
}

export function sameWorkspaceBatchModel(
  left: WorkspaceBatchModel,
  right: WorkspaceBatchModel,
): boolean {
  return left.provider === right.provider && left.modelId === right.modelId;
}

export function toggleWorkspaceBatchModel(input: {
  models: readonly WorkspaceBatchModel[];
  model: WorkspaceBatchModel;
  disabled?: boolean;
}): WorkspaceBatchModel[] | null {
  const { models, model, disabled } = input;
  if (disabled) return null;
  if (models.some((selected) => sameWorkspaceBatchModel(selected, model))) {
    return models.filter((selected) => !sameWorkspaceBatchModel(selected, model));
  }
  return models.length >= MAX_WORKSPACE_BATCH_MODELS ? null : [...models, model];
}

export function findWorkspaceBatchModel(
  providers: readonly ProviderSelectorProvider[],
  provider: string,
  modelId: string,
): WorkspaceBatchModel | undefined {
  const selection = providers.find((entry) => entry.id === provider)?.modelSelection;
  return selection?.kind === "models"
    ? selection.rows.find((row) => row.modelId === modelId)
    : undefined;
}

export function resolveModelSheetOpening({
  canSwitchProvider,
  providers,
  selectedProvider,
}: {
  canSwitchProvider: boolean;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
}): ModelBrowserView {
  if (canSwitchProvider) return { kind: "all" };

  const provider = providers.find((entry) => entry.id === selectedProvider) ?? providers[0] ?? null;
  return provider
    ? { kind: "provider", providerId: provider.id, providerLabel: provider.label }
    : { kind: "all" };
}
