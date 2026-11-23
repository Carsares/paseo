import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";

export function findModelByReference(
  models: readonly AgentModelDefinition[] | null,
  modelId: string,
): AgentModelDefinition | null {
  if (!models || models.length === 0) return null;
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return null;
  return (
    models.find((model) => model.id === normalizedModelId) ??
    models.find((model) => model.aliases?.includes(normalizedModelId)) ??
    null
  );
}

export function resolveModelSelection(input: {
  provider: string | null;
  models: readonly AgentModelDefinition[] | null;
  modelId: string;
  thinkingOptionId?: string | null;
}): { model: AgentModelDefinition; legacyThinkingOptionId?: string } | null {
  const { provider, models, modelId, thinkingOptionId } = input;
  const exact = findModelByReference(models, modelId);
  if (exact) return { model: exact };

  // COMPAT(antigravityLegacyTieredModelId): added in v0.17.0, remove after 2027-06-01.
  if (provider !== "antigravity" || !models?.length) return null;

  const legacy = /^(.+)-(minimal|low|medium|high|xhigh)$/.exec(modelId.trim());
  if (!legacy) return null;
  const [, baseId, tier] = legacy;
  const model = findModelByReference(models, baseId);
  const options = model?.thinkingOptions;
  if (!model || !options?.some((option) => option.id === tier)) return null;

  const explicit = thinkingOptionId?.trim();
  return {
    model,
    legacyThinkingOptionId:
      explicit && options.some((option) => option.id === explicit) ? explicit : tier,
  };
}

export function filterSelectableModels(
  models: AgentModelDefinition[] | null,
): AgentModelDefinition[] | null {
  return models?.filter((model) => model.isSelectable !== false) ?? null;
}
