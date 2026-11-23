import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { formatAgentModeLabel, formatThinkingOptionLabel } from "@/agent-controls/labels";
import { materializeAgentProfile, resolveProfileModelSelection } from "./materialize-profile";

export interface AgentProfileTag {
  id: string;
  label: string;
}

function findEntry(
  entries: readonly ProviderSnapshotEntry[],
  provider: string,
): ProviderSnapshotEntry | null {
  return entries.find((entry) => entry.provider === provider) ?? null;
}

function resolveModelLabel(
  entry: ProviderSnapshotEntry | null,
  modelId: string,
  selectedLabel: string | undefined,
): string {
  return selectedLabel ?? entry?.models?.find((model) => model.id === modelId)?.label ?? modelId;
}

/**
 * The one-line résumé of a profile in the settings list. Every label falls back
 * to the stored id: a row must stay readable on a host whose provider catalog
 * is offline, or that no longer ships the model the profile names.
 */
export function buildAgentProfileTags(input: {
  profile: AgentProfile;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  formatFeatureCount: (count: number) => string;
}): AgentProfileTag[] {
  const entries = input.entries ?? [];
  const entry = findEntry(entries, input.profile.provider);
  const tags: AgentProfileTag[] = [
    { id: "provider", label: entry?.label ?? input.profile.provider },
  ];

  const profile = materializeAgentProfile(input.profile);
  const selection = resolveProfileModelSelection(profile, entries);
  if (profile.modelId) {
    tags.push({
      id: "model",
      label: resolveModelLabel(entry, profile.modelId, selection?.model.label),
    });
  }

  const modeId = input.profile.modeId?.trim();
  if (modeId) {
    const mode = entry?.modes?.find((candidate) => candidate.id === modeId);
    tags.push({ id: "mode", label: mode ? formatAgentModeLabel(mode) : modeId });
  }

  const thinkingOptionId = selection?.legacyThinkingOptionId ?? profile.thinkingOptionId;
  if (thinkingOptionId) {
    tags.push({ id: "thinking", label: formatThinkingOptionLabel({ id: thinkingOptionId }) });
  }

  const featureCount = Object.keys(input.profile.options ?? {}).length;
  if (featureCount > 0) {
    tags.push({ id: "features", label: input.formatFeatureCount(featureCount) });
  }

  return tags;
}
