import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentConfigApply } from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import type { MaterializedAgentProfile } from "./materialize-profile";
import { buildAgentProfileTags } from "./profile-summary";
import {
  applyProfileToTarget,
  resolveAgentProfileApplication,
  type AgentProfileApplyTarget,
} from "./use-agent-profile-picker";

vi.mock("@/contexts/toast-context", () => ({ useToast: vi.fn() }));
vi.mock("@/hooks/use-form-preferences", () => ({ useFormPreferences: vi.fn() }));
vi.mock("@/hooks/use-providers-snapshot", () => ({ useProvidersSnapshot: vi.fn() }));
vi.mock("@/stores/session-store", () => ({ useSessionStore: vi.fn() }));
vi.mock("./use-agent-profiles", () => ({ useAgentProfiles: vi.fn() }));

const CODEX_AGENT = {
  kind: "agent",
  agentId: "agent-1",
  currentProvider: "codex",
  availableModeIds: ["read-only"],
} satisfies AgentProfileApplyTarget;

const CODEX_PROFILE: MaterializedAgentProfile = {
  provider: "codex",
  modelId: "gpt-5.2-codex",
  modeId: "read-only",
  thinkingOptionId: "high",
  options: { service_tier: "fast" },
};

const ANTIGRAVITY_PROFILE: MaterializedAgentProfile = {
  provider: "antigravity",
  modelId: "gemini-3-pro",
  modeId: "plan",
  thinkingOptionId: "",
  options: {},
};

const CODEX_ENTRY: ProviderSnapshotEntry = {
  provider: "codex",
  status: "ready",
  enabled: true,
  modes: [{ id: "read-only", label: "Read only" }],
};

const ANTIGRAVITY_ENTRY: ProviderSnapshotEntry = {
  provider: "antigravity",
  status: "ready",
  enabled: true,
  label: "Antigravity",
  modes: [{ id: "plan", label: "Plan" }],
  models: [
    {
      provider: "antigravity",
      id: "gemini-4-carbon",
      label: "Gemini 4 Carbon",
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
  ],
};

interface SwitchProviderModeCase {
  label: string;
  entry: ProviderSnapshotEntry;
  modeId: string;
  expectedModeId: string;
}

function applicationDependencies() {
  return {
    client: {
      applyAgentConfig: vi
        .fn<(_agentId: string, _config: AgentConfigApply) => Promise<null>>()
        .mockResolvedValue(null),
    },
    persistSelection: vi.fn<(profile: MaterializedAgentProfile) => void>(),
    toast: { show: vi.fn(() => vi.fn()), copied: vi.fn(), error: vi.fn() },
  };
}

describe("applyProfileToTarget", () => {
  it("applies the same Antigravity model and tier displayed by the profile picker", async () => {
    const deps = applicationDependencies();
    const resolved = {
      ...ANTIGRAVITY_PROFILE,
      modelId: "gemini-4-carbon-high",
      thinkingOptionId: "low",
    };
    const entries = [ANTIGRAVITY_ENTRY];
    const tags = buildAgentProfileTags({
      profile: {
        id: "carbon",
        name: "Carbon",
        provider: resolved.provider,
        model: resolved.modelId,
        modeId: resolved.modeId,
        thinkingOptionId: resolved.thinkingOptionId,
      },
      entries,
      formatFeatureCount: String,
    });
    expect(tags.map((tag) => tag.label)).toEqual(["Antigravity", "Gemini 4 Carbon", "Plan", "Low"]);

    await applyProfileToTarget({
      ...deps,
      target: {
        kind: "agent",
        agentId: "agent-1",
        currentProvider: "antigravity",
        availableModeIds: ["plan"],
      },
      resolved,
      entries,
    });

    expect(deps.client.applyAgentConfig).toHaveBeenCalledExactlyOnceWith("agent-1", {
      modelId: "gemini-4-carbon",
      modeId: "plan",
      thinkingOptionId: "low",
    });
    expect(deps.persistSelection).toHaveBeenCalledExactlyOnceWith({
      ...resolved,
      modelId: "gemini-4-carbon",
    });
  });

  it("passes the profile directly to the draft controls", () => {
    const applyProfile = vi.fn();
    const deps = applicationDependencies();

    applyProfileToTarget({
      ...deps,
      target: { kind: "draft", controls: { applyProfile } },
      resolved: ANTIGRAVITY_PROFILE,
      entries: [],
    });

    expect(applyProfile).toHaveBeenCalledExactlyOnceWith(ANTIGRAVITY_PROFILE);
    expect(applyProfile.mock.calls[0]?.[0]).toBe(ANTIGRAVITY_PROFILE);
    expect(deps.persistSelection).not.toHaveBeenCalled();
    expect(deps.client.applyAgentConfig).not.toHaveBeenCalled();
  });

  it.each([
    { modeId: "read-only", savedModeId: "read-only", configMode: { modeId: "read-only" } },
    { modeId: "removed-mode", savedModeId: "", configMode: {} },
  ])(
    "reconciles a same-provider mode of $modeId against the running agent",
    async ({ modeId, savedModeId, configMode }) => {
      const deps = applicationDependencies();
      const onSwitchProvider = vi.fn();

      await applyProfileToTarget({
        ...deps,
        target: { ...CODEX_AGENT, onSwitchProvider },
        resolved: { ...CODEX_PROFILE, modeId },
        entries: [],
      });

      expect(deps.persistSelection).toHaveBeenCalledExactlyOnceWith({
        ...CODEX_PROFILE,
        modeId: savedModeId,
      });
      expect(deps.persistSelection).toHaveBeenCalledBefore(deps.client.applyAgentConfig);
      expect(deps.client.applyAgentConfig).toHaveBeenCalledExactlyOnceWith("agent-1", {
        modelId: "gpt-5.2-codex",
        thinkingOptionId: "high",
        options: { service_tier: "fast" },
        ...configMode,
      });
      expect(onSwitchProvider).not.toHaveBeenCalled();
    },
  );

  it("preserves the legacy apply path without a current provider", async () => {
    const deps = applicationDependencies();

    await applyProfileToTarget({
      ...deps,
      target: { kind: "agent", agentId: "agent-1", availableModeIds: ["read-only"] },
      resolved: CODEX_PROFILE,
      entries: undefined,
    });

    expect(deps.persistSelection).toHaveBeenCalledExactlyOnceWith(CODEX_PROFILE);
    expect(deps.client.applyAgentConfig).toHaveBeenCalledOnce();
  });

  it("does nothing while the running agent's modes are unavailable", () => {
    const deps = applicationDependencies();

    applyProfileToTarget({
      ...deps,
      target: { ...CODEX_AGENT, availableModeIds: null },
      resolved: CODEX_PROFILE,
      entries: [CODEX_ENTRY],
    });

    expect(deps.persistSelection).not.toHaveBeenCalled();
    expect(deps.client.applyAgentConfig).not.toHaveBeenCalled();
  });

  it.each([
    { label: "a valid mode", entry: ANTIGRAVITY_ENTRY, modeId: "plan", expectedModeId: "plan" },
    { label: "an invalid mode", entry: ANTIGRAVITY_ENTRY, modeId: "read-only", expectedModeId: "" },
    {
      label: "a mode while the target catalog is loading",
      entry: { ...ANTIGRAVITY_ENTRY, status: "loading" },
      modeId: "unconfirmed-mode",
      expectedModeId: "unconfirmed-mode",
    },
    {
      label: "a mode while the ready catalog has no modes",
      entry: { ...ANTIGRAVITY_ENTRY, modes: undefined },
      modeId: "unconfirmed-mode",
      expectedModeId: "unconfirmed-mode",
    },
    {
      label: "a mode while the ready catalog reports an empty mode list",
      entry: { ...ANTIGRAVITY_ENTRY, modes: [] },
      modeId: "unconfirmed-mode",
      expectedModeId: "unconfirmed-mode",
    },
  ] satisfies SwitchProviderModeCase[])(
    "switches providers with $label",
    async ({ entry, modeId, expectedModeId }) => {
      const deps = applicationDependencies();
      const onSwitchProvider = vi.fn(async () => true);
      const expectedProfile = { ...ANTIGRAVITY_PROFILE, modeId: expectedModeId };

      await applyProfileToTarget({
        ...deps,
        target: { ...CODEX_AGENT, onSwitchProvider },
        resolved: { ...ANTIGRAVITY_PROFILE, modeId },
        entries: [CODEX_ENTRY, entry],
      });

      expect(onSwitchProvider).toHaveBeenCalledExactlyOnceWith(expectedProfile);
      expect(deps.persistSelection).toHaveBeenCalledExactlyOnceWith(expectedProfile);
      expect(deps.client.applyAgentConfig).not.toHaveBeenCalled();
    },
  );

  it("persists a handoff with no explicit result even if the live agent's modes are unknown", async () => {
    const deps = applicationDependencies();
    const onSwitchProvider = vi.fn(() => undefined);

    await applyProfileToTarget({
      ...deps,
      target: { ...CODEX_AGENT, availableModeIds: null, onSwitchProvider },
      resolved: ANTIGRAVITY_PROFILE,
      entries: undefined,
    });

    expect(onSwitchProvider).toHaveBeenCalledExactlyOnceWith(ANTIGRAVITY_PROFILE);
    expect(deps.persistSelection).toHaveBeenCalledExactlyOnceWith(ANTIGRAVITY_PROFILE);
    expect(deps.client.applyAgentConfig).not.toHaveBeenCalled();
  });

  it.each(["opencode", "custom-opencode"])(
    "preserves an OpenCode project mode for %s",
    async (provider) => {
      const deps = applicationDependencies();
      const onSwitchProvider = vi.fn(async () => true);
      const resolved = { ...ANTIGRAVITY_PROFILE, provider, modeId: "project-review" };
      await applyProfileToTarget({
        ...deps,
        target: { ...CODEX_AGENT, onSwitchProvider },
        resolved,
        entries: [{ ...ANTIGRAVITY_ENTRY, provider, derivedFromProviderId: "opencode" }],
      });
      expect(onSwitchProvider).toHaveBeenCalledExactlyOnceWith(resolved);
    },
  );

  it("leaves preferences alone while the handoff is pending and when it is canceled", async () => {
    const deps = applicationDependencies();
    const handoff = Promise.withResolvers<boolean>();
    const onSwitchProvider = vi.fn(() => handoff.promise);

    const applied = applyProfileToTarget({
      ...deps,
      target: { ...CODEX_AGENT, onSwitchProvider },
      resolved: ANTIGRAVITY_PROFILE,
      entries: [ANTIGRAVITY_ENTRY],
    });

    expect(onSwitchProvider).toHaveBeenCalledExactlyOnceWith(ANTIGRAVITY_PROFILE);
    expect(deps.persistSelection).not.toHaveBeenCalled();
    handoff.resolve(false);
    await applied;
    expect(deps.persistSelection).not.toHaveBeenCalled();
    expect(deps.client.applyAgentConfig).not.toHaveBeenCalled();
  });

  it("passes the full in-place profile through even if its mode is absent from the host catalog", async () => {
    const deps = applicationDependencies();
    const onSwitchProvider = vi.fn(async () => true);
    const resolved = {
      ...ANTIGRAVITY_PROFILE,
      modeId: "workspace-mode",
      thinkingOptionId: "high",
      options: { effort: "high" },
    };

    await applyProfileToTarget({
      ...deps,
      target: {
        ...CODEX_AGENT,
        onSwitchProvider,
        switchesProviderInPlace: true,
      },
      resolved,
      entries: [ANTIGRAVITY_ENTRY],
    });

    expect(onSwitchProvider).toHaveBeenCalledExactlyOnceWith(resolved);
    expect(deps.persistSelection).not.toHaveBeenCalled();
    expect(deps.client.applyAgentConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a rejected handoff",
      createOnSwitchProvider: (error: Error) => vi.fn().mockRejectedValue(error),
    },
    {
      label: "a synchronously throwing handoff",
      createOnSwitchProvider: (error: Error) =>
        vi.fn(() => {
          throw error;
        }),
    },
  ])(
    "reports $label without writing preferences or applying agent config",
    async ({ createOnSwitchProvider }) => {
      const deps = applicationDependencies();
      const error = new Error("Handoff failed");
      const onSwitchProvider = createOnSwitchProvider(error);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        await applyProfileToTarget({
          ...deps,
          target: { ...CODEX_AGENT, onSwitchProvider },
          resolved: ANTIGRAVITY_PROFILE,
          entries: [ANTIGRAVITY_ENTRY],
        });

        expect(warn).toHaveBeenCalledExactlyOnceWith(
          "[useAgentProfilePicker] switch provider profile failed",
          error,
        );
        expect(deps.toast.error).toHaveBeenCalledExactlyOnceWith("Handoff failed");
        expect(deps.persistSelection).not.toHaveBeenCalled();
        expect(deps.client.applyAgentConfig).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("does nothing for a different provider when no handoff is available", () => {
    const deps = applicationDependencies();
    const input = {
      target: CODEX_AGENT,
      resolved: ANTIGRAVITY_PROFILE,
      entries: [ANTIGRAVITY_ENTRY],
    };

    expect(resolveAgentProfileApplication(input)).toBeNull();
    applyProfileToTarget({ ...deps, ...input });

    expect(deps.persistSelection).not.toHaveBeenCalled();
    expect(deps.client.applyAgentConfig).not.toHaveBeenCalled();
  });
});
