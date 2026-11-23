import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "./agent-sdk-types.js";
import { validateAgentConfigurationAgainstProvider } from "./agent-configuration-validator.js";

const provider: ProviderSnapshotEntry = {
  provider: "antigravity",
  enabled: true,
  status: "ready",
  models: [
    {
      provider: "antigravity",
      id: "gemini-4-carbon",
      aliases: ["carbon"],
      label: "Gemini 4 Carbon",
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
    {
      provider: "antigravity",
      id: "gpt-oss-120b",
      aliases: ["gpt-oss-native"],
      label: "GPT OSS 120B",
      thinkingOptions: [{ id: "medium", label: "Medium" }],
    },
    {
      provider: "antigravity",
      id: "gpt-oss-120b-medium",
      aliases: ["gpt-oss-native-medium"],
      label: "GPT OSS 120B Medium",
    },
  ],
};

describe("Antigravity configuration validation", () => {
  it.each([
    ["gemini-4-carbon-high", undefined],
    ["carbon-high", "low"],
  ])("accepts legacy model %s with explicit thinking %j", (model, thinkingOptionId) => {
    expect(
      validateAgentConfigurationAgainstProvider({
        provider,
        input: { provider: "antigravity", model, thinkingOptionId },
      }),
    ).toEqual([]);
  });

  it("reports an unsupported explicit tier for a direct request with a recognized old model", () => {
    const issues = validateAgentConfigurationAgainstProvider({
      provider,
      input: { provider: "antigravity", model: "carbon-high", thinkingOptionId: "removed-tier" },
    });
    expect(issues.map((issue) => issue.path)).toEqual([["thinkingOptionId"]]);
  });

  it.each(["gemini-4-carbon-ultra", "gemini-4-carbon-xhigh"])(
    "still rejects unknown or unsupported legacy model %s",
    (model) => {
      const issues = validateAgentConfigurationAgainstProvider({
        provider,
        input: { provider: "antigravity", model },
      });
      expect(issues.map((issue) => issue.path)).toEqual([["model"]]);
    },
  );

  it.each(["gpt-oss-120b-medium", "gpt-oss-native-medium"])(
    "validates the full model reference %s without splitting the tier",
    (model) => {
      const issues = validateAgentConfigurationAgainstProvider({
        provider,
        input: { provider: "antigravity", model, thinkingOptionId: "medium" },
      });
      expect(issues.map((issue) => issue.path)).toEqual([["thinkingOptionId"]]);
    },
  );

  it("does not accept a tier suffix for other providers", () => {
    const issues = validateAgentConfigurationAgainstProvider({
      provider: { ...provider, provider: "codex" },
      input: { provider: "codex", model: "carbon-high" },
    });
    expect(issues.map((issue) => issue.path)).toEqual([["model"]]);
  });
});
