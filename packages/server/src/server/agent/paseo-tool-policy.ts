import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import { applyHierarchyPaseoToolPolicy } from "./hierarchy-policy.js";
import type { HierarchyAgent, PaseoToolPolicy } from "./hierarchy-policy.js";

interface ProviderPaseoToolSettings {
  paseoTools?: ProviderPaseoToolsPolicy;
}

export function resolvePaseoToolPolicy(
  providerId: string,
  providerSettings: Readonly<Record<string, ProviderPaseoToolSettings>> | undefined,
): ProviderPaseoToolsPolicy | undefined {
  return providerSettings?.[providerId]?.paseoTools;
}

export function isPaseoToolEnabled(policy: PaseoToolPolicy | undefined, toolName: string): boolean {
  if (policy?.allowedTools && !policy.allowedTools.includes(toolName)) {
    return false;
  }
  if (toolName === "speak") {
    return true;
  }
  if (!isPaseoToolPolicyEnabled(policy)) {
    return false;
  }
  return !policy?.disabledTools?.includes(toolName);
}

export function isPaseoToolPolicyEnabled(policy: ProviderPaseoToolsPolicy | undefined): boolean {
  return policy?.enabled !== false;
}

export function resolveAgentPaseoToolPolicy(
  policy: ProviderPaseoToolsPolicy | undefined,
  agent: HierarchyAgent | undefined,
  depth: number,
): PaseoToolPolicy | undefined {
  return applyHierarchyPaseoToolPolicy(policy, agent?.labels, depth);
}
