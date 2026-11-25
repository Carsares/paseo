import type { AgentModelDefinition, ProviderOptions } from "@getpaseo/protocol/agent-types";
import type { HubExecutionAgentValidationIssue } from "@getpaseo/protocol/messages";

import type { ProviderSnapshotEntry } from "./agent-sdk-types.js";
import { filterSelectableAgentModels } from "./agent-sdk-types.js";

export interface AgentConfigurationValidationInput {
  provider: string;
  cwd?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  providerOptions?: ProviderOptions;
}

interface AgentConfigurationValidationContext {
  input: AgentConfigurationValidationInput;
  provider: ProviderSnapshotEntry;
}

function findAntigravityModel(
  models: AgentModelDefinition[],
  id: string,
): AgentModelDefinition | undefined {
  const reference = id.trim();
  return (
    models.find((model) => model.id === reference) ??
    models.find((model) => model.aliases?.includes(reference))
  );
}

// COMPAT(antigravityLegacyTieredModelId): added in v0.17.0, remove after 2027-06-01.
function findAntigravityLegacyModel(
  models: AgentModelDefinition[],
  requestedModel: string,
): AgentModelDefinition | undefined {
  const legacy = /^(.+)-(minimal|low|medium|high|xhigh)$/.exec(requestedModel.trim());
  if (!legacy) return undefined;
  const [, baseId, tier] = legacy;
  const model = findAntigravityModel(models, baseId);
  return model?.thinkingOptions?.some((option) => option.id === tier) ? model : undefined;
}

export function validateAgentConfigurationAgainstProvider({
  input,
  provider,
}: AgentConfigurationValidationContext): HubExecutionAgentValidationIssue[] {
  const issues: HubExecutionAgentValidationIssue[] = [];
  const models = filterSelectableAgentModels(provider.models);
  const requestedModel = input.model;
  let selectedModel: AgentModelDefinition | undefined;
  if (!requestedModel) {
    selectedModel = models.find((model) => model.isDefault) ?? models[0];
  } else if (provider.provider === "antigravity") {
    selectedModel =
      findAntigravityModel(models, requestedModel) ??
      findAntigravityLegacyModel(models, requestedModel);
  } else {
    selectedModel = models.find(
      (model) => model.id === requestedModel || model.aliases?.includes(requestedModel),
    );
  }

  if (requestedModel && !selectedModel) {
    issues.push({
      path: ["model"],
      message: `Model '${requestedModel}' is not available for provider '${input.provider}'`,
    });
  }
  if (input.modeId && !provider.modes?.some((mode) => mode.id === input.modeId)) {
    issues.push({
      path: ["modeId"],
      message: `Mode '${input.modeId}' is not available for provider '${input.provider}'`,
    });
  }
  if (
    input.thinkingOptionId &&
    !selectedModel?.thinkingOptions?.some((option) => option.id === input.thinkingOptionId)
  ) {
    issues.push({
      path: ["thinkingOptionId"],
      message: `Thinking option '${input.thinkingOptionId}' is not available for provider '${input.provider}'`,
    });
  }

  return issues;
}
