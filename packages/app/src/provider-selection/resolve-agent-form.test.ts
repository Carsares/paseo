import { describe, expect, it } from "vitest";
import {
  resolveAgentForm,
  resolveFormState,
  resolveEffectiveModel,
  resolveThinkingOptionId,
  mergeSelectedComposerPreferences,
  buildProviderDefinitionMap,
  buildProviderDefinitionMapForStatuses,
  resolveDefaultModel,
  INITIAL_USER_MODIFIED,
  PENDING_AGENT_FORM_RESOLUTION,
  type AgentFormReducerState,
  type AgentFormResolutionState,
  type ProviderModelsByProvider,
  type UserModifiedFields,
} from "./resolve-agent-form";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type {
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";

const TEST_CODEX_DEFINITION: AgentProviderDefinition = {
  id: "codex",
  label: "Codex",
  description: "Codex test provider",
  defaultModeId: "auto",
  modes: [
    { id: "auto", label: "Auto", icon: "ShieldAlert", colorTier: "moderate" },
    { id: "full-access", label: "Full Access", icon: "ShieldAlert", colorTier: "dangerous" },
  ],
};

const TEST_CLAUDE_DEFINITION: AgentProviderDefinition = {
  id: "claude",
  label: "Claude",
  description: "Claude test provider",
  defaultModeId: "default",
  modes: [
    { id: "default", label: "Always Ask", icon: "ShieldCheck", colorTier: "safe" },
    { id: "acceptEdits", label: "Accept File Edits", icon: "ShieldAlert", colorTier: "moderate" },
    { id: "plan", label: "Plan Mode", icon: "ShieldCheck", colorTier: "planning" },
    { id: "bypassPermissions", label: "Bypass", icon: "ShieldAlert", colorTier: "dangerous" },
  ],
};

const TEST_PI_DEFINITION: AgentProviderDefinition = {
  id: "pi",
  label: "Pi",
  description: "Pi test provider",
  defaultModeId: null,
  modes: [],
};

const CODEX_MODELS: AgentModelDefinition[] = [
  {
    provider: "codex",
    id: "gpt-5.3-codex",
    label: "gpt-5.3-codex",
    isDefault: true,
    defaultThinkingOptionId: "xhigh",
    thinkingOptions: [
      { id: "low", label: "low" },
      { id: "xhigh", label: "xhigh", isDefault: true },
    ],
  },
];

const ALIASED_CODEX_MODELS: AgentModelDefinition[] = [
  { ...CODEX_MODELS[0], aliases: ["gpt-5.3-codex-legacy"] },
];

const ANTIGRAVITY_MODELS: AgentModelDefinition[] = [
  {
    provider: "antigravity",
    id: "gemini-4-neon",
    label: "Gemini 4 Neon",
    isDefault: true,
    defaultThinkingOptionId: "high",
    thinkingOptions: [
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra high" },
    ],
  },
  {
    provider: "antigravity",
    id: "gemini-4-carbon",
    aliases: ["carbon"],
    label: "Gemini 4 Carbon",
    defaultThinkingOptionId: "low",
    thinkingOptions: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
  },
  {
    provider: "antigravity",
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    thinkingOptions: [{ id: "high", label: "High" }],
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
];

function makeProviderMap(
  ...definitions: AgentProviderDefinition[]
): Map<AgentProvider, AgentProviderDefinition> {
  return new Map(definitions.map((d) => [d.id, d]));
}

const codexProviderMap = makeProviderMap(TEST_CODEX_DEFINITION);
const claudeProviderMap = makeProviderMap(TEST_CLAUDE_DEFINITION);
const bothProviderMap = makeProviderMap(TEST_CODEX_DEFINITION, TEST_CLAUDE_DEFINITION);

function makeState(
  overrides: Partial<AgentFormReducerState["form"]> = {},
  modified: Partial<UserModifiedFields> = {},
  resolution: AgentFormResolutionState = PENDING_AGENT_FORM_RESOLUTION,
): AgentFormReducerState {
  return {
    form: {
      provider: null,
      modeId: "",
      model: "",
      thinkingOptionId: "",

      ...overrides,
    },
    userModified: { ...INITIAL_USER_MODIFIED, ...modified },
    resolution,
  };
}

function makeProviderModelsByProvider(
  entries: Array<[AgentProvider, AgentModelDefinition[] | null]>,
): ProviderModelsByProvider {
  return new Map(entries);
}

describe("resolveDefaultModel", () => {
  it("returns null for empty or null input", () => {
    expect(resolveDefaultModel(null)).toBeNull();
    expect(resolveDefaultModel([])).toBeNull();
  });

  it("returns the model marked isDefault", () => {
    const models: AgentModelDefinition[] = [
      { provider: "codex", id: "a", label: "A", isDefault: false },
      { provider: "codex", id: "b", label: "B", isDefault: true },
    ];
    expect(resolveDefaultModel(models)?.id).toBe("b");
  });

  it("falls back to the first model when none is marked default", () => {
    const models: AgentModelDefinition[] = [
      { provider: "codex", id: "a", label: "A", isDefault: false },
      { provider: "codex", id: "b", label: "B", isDefault: false },
    ];
    expect(resolveDefaultModel(models)?.id).toBe("a");
  });
});

describe("model aliases", () => {
  it("canonicalizes a retired preferred model and restores thinking from its alias key", () => {
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.3-codex-legacy",
            thinkingByModel: { "gpt-5.3-codex-legacy": "low" },
          },
        },
      },
      ALIASED_CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState().form,
      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("low");
  });

  it("prefers thinking stored under the canonical model id over an alias", () => {
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.3-codex-legacy",
            thinkingByModel: {
              "gpt-5.3-codex": "xhigh",
              "gpt-5.3-codex-legacy": "low",
            },
          },
        },
      },
      ALIASED_CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState().form,
      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("prefers an exact configured model id over another model's alias", () => {
    const configuredAlias: AgentModelDefinition = {
      provider: "codex",
      id: "gpt-5.3-codex-legacy",
      label: "Gateway legacy model",
      defaultThinkingOptionId: "medium",
      thinkingOptions: [{ id: "medium", label: "medium", isDefault: true }],
    };
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: { codex: { model: configuredAlias.id } },
      },
      [...ALIASED_CODEX_MODELS, configuredAlias],
      INITIAL_USER_MODIFIED,
      makeState().form,
      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex-legacy");
    expect(resolved.thinkingOptionId).toBe("medium");
  });
});

describe("resolveThinkingOptionId", () => {
  it("returns empty string when model has no thinking options", () => {
    const modelsWithoutThinking: AgentModelDefinition[] = [
      { provider: "claude", id: "claude-sonnet-4-6", label: "Sonnet 4.6", isDefault: true },
    ];
    expect(
      resolveThinkingOptionId({
        availableModels: modelsWithoutThinking,
        modelId: "claude-sonnet-4-6",
        requestedThinkingOptionId: "",
      }),
    ).toBe("");
  });

  it("returns the requested option when it is valid", () => {
    expect(
      resolveThinkingOptionId({
        availableModels: CODEX_MODELS,
        modelId: "gpt-5.3-codex",
        requestedThinkingOptionId: "low",
      }),
    ).toBe("low");
  });

  it("falls back to defaultThinkingOptionId when requested option is invalid", () => {
    expect(
      resolveThinkingOptionId({
        availableModels: CODEX_MODELS,
        modelId: "gpt-5.3-codex",
        requestedThinkingOptionId: "invalid",
      }),
    ).toBe("xhigh");
  });

  it("falls back to first option when no default and requested is invalid", () => {
    const modelsNoDefault: AgentModelDefinition[] = [
      {
        provider: "codex",
        id: "m",
        label: "M",
        isDefault: true,
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ];
    expect(
      resolveThinkingOptionId({
        availableModels: modelsNoDefault,
        modelId: "m",
        requestedThinkingOptionId: "",
      }),
    ).toBe("low");
  });
});

describe("mergeSelectedComposerPreferences", () => {
  it("stores the selected model for the selected provider", () => {
    expect(
      mergeSelectedComposerPreferences({
        preferences: {},
        provider: "codex",
        updates: { model: "gpt-5.4" },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: { codex: { model: "gpt-5.4" } },
    });
  });

  it("preserves existing provider preferences when the selected model changes", () => {
    expect(
      mergeSelectedComposerPreferences({
        preferences: {
          provider: "claude",
          providerPreferences: {
            codex: {
              mode: "full-access",
              thinkingByModel: { "gpt-5.4-mini": "medium" },
              options: { fast_mode: true },
            },
            claude: { model: "claude-sonnet-4-6" },
          },
        },
        provider: "codex",
        updates: { model: "gpt-5.4" },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.4",
          mode: "full-access",
          thinkingByModel: { "gpt-5.4-mini": "medium" },
          options: { fast_mode: true },
        },
        claude: { model: "claude-sonnet-4-6" },
      },
    });
  });

  it("stores mode and thinking preferences without dropping the selected model", () => {
    expect(
      mergeSelectedComposerPreferences({
        preferences: {
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-5.4",
              mode: "auto",
              thinkingByModel: { "gpt-5.4-mini": "low" },
            },
          },
        },
        provider: "codex",
        updates: {
          mode: "full-access",
          thinkingByModel: { "gpt-5.4": "xhigh" },
        },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.4",
          mode: "full-access",
          thinkingByModel: { "gpt-5.4-mini": "low", "gpt-5.4": "xhigh" },
        },
      },
    });
  });
});

describe("buildProviderDefinitions", () => {
  it("returns empty array when snapshot data is unavailable", () => {
    expect(buildProviderDefinitions(undefined)).toEqual([]);
    expect(buildProviderDefinitions([])).toEqual([]);
  });

  it("builds provider definitions from snapshot metadata", () => {
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "zai",
        status: "ready",
        enabled: true,
        label: "ZAI",
        description: "Claude with ZAI config",
        defaultModeId: "default",
        modes: [
          {
            id: "default",
            label: "Default",
            description: "Safe mode",
            icon: "ShieldCheck",
            colorTier: "safe",
          },
        ],
      },
    ];

    expect(buildProviderDefinitions(entries)).toEqual([
      {
        id: "zai",
        label: "ZAI",
        description: "Claude with ZAI config",
        defaultModeId: "default",
        modes: [
          {
            id: "default",
            label: "Default",
            description: "Safe mode",
            icon: "ShieldCheck",
            colorTier: "safe",
          },
        ],
      },
    ]);
  });
});

describe("resolveFormState", () => {
  it("keeps provider, mode, and model unset on first open without preferences or explicit values", () => {
    const resolved = resolveFormState(
      undefined,
      {},
      null,
      INITIAL_USER_MODIFIED,
      makeState().form,

      bothProviderMap,
    );

    expect(resolved.provider).toBeNull();
    expect(resolved.modeId).toBe("");
    expect(resolved.model).toBe("");
    expect(resolved.thinkingOptionId).toBe("");
  });

  it("does not auto-select a model on fresh drafts without preferences", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.model).toBe("");
    expect(resolved.thinkingOptionId).toBe("");
  });

  it("auto-selects the model's default thinking option when model is preferred but thinking is not", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex", providerPreferences: { codex: { model: "gpt-5.3-codex" } } },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("falls back to model default when saved thinking preference is invalid", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex", providerPreferences: { codex: { model: "gpt-5.3-codex" } } },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("normalizes legacy model id 'default' from initial values to the provider default model", () => {
    const resolved = resolveFormState(
      { model: "default" },
      { provider: "codex" },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
  });

  it("keeps an explicit initial thinking option when it is valid", () => {
    const resolved = resolveFormState(
      { model: "gpt-5.3-codex", thinkingOptionId: "low" },
      { provider: "codex" },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("low");
  });

  it("falls back to the first thinking option when model exposes options without a provider default", () => {
    const claudeWithThinking: AgentModelDefinition[] = [
      {
        provider: "claude",
        id: "default",
        label: "Default (Sonnet 4.6)",
        isDefault: true,
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
        ],
      },
    ];

    const resolved = resolveFormState(
      undefined,
      { provider: "claude", providerPreferences: { claude: { model: "default" } } },
      claudeWithThinking,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "claude" }).form,

      claudeProviderMap,
    );

    expect(resolved.model).toBe("default");
    expect(resolved.thinkingOptionId).toBe("low");
  });

  it("preserves the remembered provider when it is absent from the available catalogue", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      claudeProviderMap,
    );

    expect(resolved.provider).toBe("codex");
  });

  it("preserves a user-selected provider and model while that provider is loading during refresh", () => {
    const loadingEntries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "loading",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
        modes: TEST_CODEX_DEFINITION.modes,
      },
      {
        provider: "claude",
        status: "ready",
        enabled: true,
        label: TEST_CLAUDE_DEFINITION.label,
        description: TEST_CLAUDE_DEFINITION.description,
        defaultModeId: TEST_CLAUDE_DEFINITION.defaultModeId,
        modes: TEST_CLAUDE_DEFINITION.modes,
        models: [{ provider: "claude", id: "default", label: "Default", isDefault: true }],
      },
    ];
    const providerDefinitions = buildProviderDefinitions(loadingEntries);
    const resolvableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: loadingEntries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]),
    });

    const resolved = resolveFormState(
      undefined,
      {},
      null,
      {
        provider: true,
        modeId: true,
        model: true,
        thinkingOptionId: true,
      },
      makeState({
        provider: "codex",
        modeId: "full-access",
        model: "gpt-5.3-codex",
        thinkingOptionId: "xhigh",
      }).form,

      resolvableProviderMap,
    );

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("full-access");
    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("preserves the saved mode while provider modes are absent from a loading snapshot", () => {
    const loadingEntries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "loading",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
      },
    ];
    const providerDefinitions = buildProviderDefinitions(loadingEntries);
    const resolvableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: loadingEntries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]),
    });

    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: { codex: { mode: "full-access", model: "gpt-5.3-codex" } },
      },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex", modeId: "full-access", model: "gpt-5.3-codex" }).form,

      resolvableProviderMap,
    );

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("full-access");
  });

  it("preserves a saved mode that is not in the current mode list", () => {
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: { codex: { mode: "workspace-write", model: "gpt-5.3-codex" } },
      },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("workspace-write");
  });

  it("falls back when the provider cannot advertise its preferred default mode", () => {
    const providerMap = makeProviderMap({
      ...TEST_CODEX_DEFINITION,
      defaultModeId: "auto-review",
      modes: TEST_CODEX_DEFINITION.modes,
    });

    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,
      providerMap,
    );

    expect(resolved.modeId).toBe("auto");
  });

  it("preserves saved intent even when a provider is disabled", () => {
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
        modes: TEST_CODEX_DEFINITION.modes,
      },
      {
        provider: "claude",
        status: "ready",
        enabled: false,
        label: TEST_CLAUDE_DEFINITION.label,
        description: TEST_CLAUDE_DEFINITION.description,
        defaultModeId: TEST_CLAUDE_DEFINITION.defaultModeId,
        modes: TEST_CLAUDE_DEFINITION.modes,
      },
    ];
    const providerDefinitions = buildProviderDefinitions(entries);
    const selectableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: entries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready"]),
    });

    const resolved = resolveFormState(
      undefined,
      { provider: "claude" },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      selectableProviderMap,
    );

    expect(resolved.provider).toBe("claude");
    expect(resolved.modeId).toBe("");
  });

  it("excludes disabled providers from the selectable provider map without removing them from snapshot definitions", () => {
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
        modes: TEST_CODEX_DEFINITION.modes,
      },
      {
        provider: "claude",
        status: "ready",
        enabled: false,
        label: TEST_CLAUDE_DEFINITION.label,
        description: TEST_CLAUDE_DEFINITION.description,
        defaultModeId: TEST_CLAUDE_DEFINITION.defaultModeId,
        modes: TEST_CLAUDE_DEFINITION.modes,
      },
    ];
    const providerDefinitions = buildProviderDefinitions(entries);

    const selectableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: entries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready"]),
    });

    expect([...selectableProviderMap.keys()]).toEqual(["codex"]);
    expect(providerDefinitions.map((d) => d.id)).toEqual(["codex", "claude"]);
  });

  it("preserves a user-selected provider when the refreshed snapshot marks it unavailable", () => {
    const unavailableEntries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "unavailable",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
        modes: TEST_CODEX_DEFINITION.modes,
      },
      {
        provider: "claude",
        status: "ready",
        enabled: true,
        label: TEST_CLAUDE_DEFINITION.label,
        description: TEST_CLAUDE_DEFINITION.description,
        defaultModeId: TEST_CLAUDE_DEFINITION.defaultModeId,
        modes: TEST_CLAUDE_DEFINITION.modes,
        models: [{ provider: "claude", id: "default", label: "Default", isDefault: true }],
      },
    ];
    const providerDefinitions = buildProviderDefinitions(unavailableEntries);
    const resolvableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: unavailableEntries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]),
    });

    const resolved = resolveFormState(
      undefined,
      {},
      null,
      {
        ...INITIAL_USER_MODIFIED,
        provider: true,
        modeId: true,
        model: true,
        thinkingOptionId: true,
      },
      makeState({
        provider: "codex",
        modeId: "full-access",
        model: "gpt-5.3-codex",
        thinkingOptionId: "xhigh",
      }).form,

      resolvableProviderMap,
    );

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("full-access");
    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("does not force fallback provider when allowed provider map is empty", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      new Map<AgentProvider, AgentProviderDefinition>(),
    );

    expect(resolved.provider).toBe("codex");
  });
});

it("keeps the explicit model when a refreshed catalogue no longer lists it", () => {
  const resolved = resolveFormState(
    undefined,
    { provider: "codex", providerPreferences: { codex: { model: "gpt-6-astra" } } },
    CODEX_MODELS,
    INITIAL_USER_MODIFIED,
    makeState().form,
    codexProviderMap,
  );
  expect(resolved.model).toBe("gpt-6-astra");
  // Label/persistence lookup must not reinterpret the submitted ID as another model.
  expect(resolveEffectiveModel(CODEX_MODELS, resolved.model)).toBeNull();
});

describe("resolveAgentForm", () => {
  describe("resolution state", () => {
    it.each(["error", "unavailable"] as const)(
      "restores a remembered model after opening against a %s provider snapshot",
      (status) => {
        const preferences = {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex" } },
        };
        const snapshotEntries: ProviderSnapshotEntry[] = [
          {
            provider: "codex",
            enabled: true,
            status,
            models: [],
          },
        ];
        const opened = resolveAgentForm(makeState(), {
          type: "COMPLETE_RESOLUTION",
          initialValues: undefined,
          preferences,
          providerModelsByProvider: makeProviderModelsByProvider([["codex", []]]),
          allowedProviderMap: buildProviderDefinitionMapForStatuses({
            snapshotEntries,
            providerDefinitions: buildProviderDefinitions(snapshotEntries),
            statuses: new Set(["ready", "loading"]),
          }),
        });
        const recovered = resolveAgentForm(opened, {
          type: "COMPLETE_RESOLUTION",
          initialValues: undefined,
          preferences,
          providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
          allowedProviderMap: codexProviderMap,
        });

        expect(recovered.form).toMatchObject({
          provider: "codex",
          model: "gpt-5.3-codex",
        });
      },
    );

    it("requests resolution without changing the current form values", () => {
      const state = makeState(
        { provider: "codex", modeId: "auto", model: "gpt-5.3-codex" },
        { provider: true, model: true },
        { status: "completed" },
      );
      const next = resolveAgentForm(state, { type: "REQUEST_RESOLUTION" });

      expect(next.form).toEqual(state.form);
      expect(next.userModified).toEqual(INITIAL_USER_MODIFIED);
      expect(next.resolution.status).toBe("pending");
    });

    it("completes a pending open resolution when snapshot models arrive late", () => {
      const state = resolveAgentForm(makeState(), {
        type: "REQUEST_RESOLUTION",
      });
      const next = resolveAgentForm(state, {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex" } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
        allowedProviderMap: codexProviderMap,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.modeId).toBe("auto");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.thinkingOptionId).toBe("xhigh");
      expect(next.resolution.status).toBe("completed");
    });

    it("does not change settled selection when a background snapshot has different defaults", () => {
      const settled = resolveAgentForm(makeState(), {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex" } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
        allowedProviderMap: codexProviderMap,
      });
      const backgroundModels: AgentModelDefinition[] = [
        { provider: "codex", id: "gpt-5.4-codex", label: "gpt-5.4-codex", isDefault: true },
      ];
      const next = resolveAgentForm(settled, {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.4-codex" } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", backgroundModels]]),
        allowedProviderMap: codexProviderMap,
      });

      expect(next).toBe(settled);
      expect(next.form.provider).toBe("codex");
      expect(next.form.model).toBe("gpt-5.3-codex");
    });

    it("prefills edit hydration from initial values", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "COMPLETE_RESOLUTION",
        initialValues: {
          provider: "codex",
          modeId: "full-access",
          model: "gpt-5.3-codex",
          thinkingOptionId: "low",
        },
        preferences: { provider: "claude" },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
        allowedProviderMap: bothProviderMap,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.modeId).toBe("full-access");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.thinkingOptionId).toBe("low");
    });

    it("keeps a user model change after resolution has completed", () => {
      const alternateModels: AgentModelDefinition[] = [
        ...CODEX_MODELS,
        { provider: "codex", id: "gpt-5.4-codex", label: "gpt-5.4-codex" },
      ];
      const settled = resolveAgentForm(makeState(), {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex" } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", alternateModels]]),
        allowedProviderMap: codexProviderMap,
      });
      const userChanged = resolveAgentForm(settled, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.4-codex",
        availableModels: alternateModels,
        providerPrefs: undefined,
      });
      const next = resolveAgentForm(userChanged, {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex" } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
        allowedProviderMap: codexProviderMap,
      });

      expect(next).toBe(userChanged);
      expect(next.form.model).toBe("gpt-5.4-codex");
      expect(next.userModified.model).toBe(true);
    });

    it("does not override user-modified provider while completing", () => {
      const state = makeState({ provider: "codex", modeId: "auto" }, { provider: true });
      const next = resolveAgentForm(state, {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: { provider: "claude" },
        providerModelsByProvider: makeProviderModelsByProvider([]),
        allowedProviderMap: bothProviderMap,
      });

      expect(next.form.provider).toBe("codex");
    });
  });

  describe("SET_PROVIDER_AND_MODEL_FROM_USER", () => {
    it("sets provider, model, and default mode; marks both modified", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "gpt-5.3-codex",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.modeId).toBe("auto");
      expect(next.userModified.provider).toBe(true);
      expect(next.userModified.model).toBe(true);
    });

    it("preserves the current preferred mode when selecting a provider and model", () => {
      const state = makeState({ provider: "codex", modeId: "full-access" });
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "gpt-5.3-codex",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.modeId).toBe("full-access");
    });

    it("falls back to provider default model when modelId is empty", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
      });

      expect(next.form.model).toBe("gpt-5.3-codex");
    });

    it("selects default thinking option for the chosen model", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "gpt-5.3-codex",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
        providerPrefs: { thinkingByModel: { "gpt-5.3-codex": "low" } },
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });
  });

  describe("SET_MODE_FROM_USER", () => {
    it("updates modeId and marks it modified", () => {
      const state = makeState({ provider: "codex", modeId: "auto" });
      const next = resolveAgentForm(state, { type: "SET_MODE_FROM_USER", modeId: "full-access" });

      expect(next.form.modeId).toBe("full-access");
      expect(next.userModified.modeId).toBe(true);
    });
  });

  describe("APPLY_PROFILE_FROM_USER", () => {
    it("drops a stale saved mode for a modeless profile provider", () => {
      const next = resolveAgentForm(makeState({ provider: "codex", modeId: "full-access" }), {
        type: "APPLY_PROFILE_FROM_USER",
        provider: "pi",
        modelId: "anthropic/sonnet",
        modeId: "",
        thinkingOptionId: "",
        providerDef: TEST_PI_DEFINITION,
        providerModels: [{ provider: "pi", id: "anthropic/sonnet", label: "Sonnet" }],
        providerPrefs: { mode: "full-access" },
      });

      expect(next.form).toMatchObject({
        provider: "pi",
        model: "anthropic/sonnet",
        modeId: "",
      });
    });

    it("restores thinking for the selected model when the profile omits it", () => {
      const next = resolveAgentForm(makeState(), {
        type: "APPLY_PROFILE_FROM_USER",
        provider: "codex",
        modelId: "gpt-5.3-codex",
        modeId: "full-access",
        thinkingOptionId: "",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
        providerPrefs: { thinkingByModel: { "gpt-5.3-codex": "low" } },
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });
  });

  describe("SET_MODEL_FROM_USER", () => {
    it("updates model and resets thinking to model default when thinking is not user-modified", () => {
      const state = makeState({ provider: "codex", model: "", thinkingOptionId: "" });
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.3-codex",
        availableModels: CODEX_MODELS,
        providerPrefs: undefined,
      });

      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.thinkingOptionId).toBe("xhigh");
      expect(next.userModified.model).toBe(true);
    });

    it("preserves user-chosen thinking option when switching to same model", () => {
      const state = makeState(
        { provider: "codex", model: "gpt-5.3-codex", thinkingOptionId: "low" },
        { thinkingOptionId: true },
      );
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.3-codex",
        availableModels: CODEX_MODELS,
        providerPrefs: { thinkingByModel: { "gpt-5.3-codex": "xhigh" } },
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });

    it("falls back to provider default model when modelId is blank", () => {
      const state = makeState({ provider: "codex" });
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "  ",
        availableModels: CODEX_MODELS,
        providerPrefs: undefined,
      });

      expect(next.form.model).toBe("gpt-5.3-codex");
    });

    it("restores the target model's saved thinking option", () => {
      const models = [
        ...CODEX_MODELS,
        {
          provider: "codex" as const,
          id: "gpt-other",
          label: "Other",
          defaultThinkingOptionId: "xhigh",
          thinkingOptions: CODEX_MODELS[0].thinkingOptions,
        },
      ];
      const state = makeState({
        provider: "codex",
        model: "gpt-other",
        thinkingOptionId: "xhigh",
      });
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.3-codex",
        availableModels: models,
        providerPrefs: { thinkingByModel: { "gpt-5.3-codex": "low" } },
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });
  });

  describe("SET_THINKING_OPTION_FROM_USER", () => {
    it("updates thinkingOptionId and marks it modified", () => {
      const state = makeState({ thinkingOptionId: "xhigh" });
      const next = resolveAgentForm(state, {
        type: "SET_THINKING_OPTION_FROM_USER",
        thinkingOptionId: "low",
      });

      expect(next.form.thinkingOptionId).toBe("low");
      expect(next.userModified.thinkingOptionId).toBe(true);
    });
  });

  describe("RESET", () => {
    it("keeps form values but marks them unresolved for the next open", () => {
      const state = makeState(
        { provider: "codex", modeId: "full-access", model: "gpt-5.3-codex" },
        { provider: true, modeId: true, model: true },
        { status: "completed" },
      );
      const next = resolveAgentForm(state, { type: "RESET" });

      expect(next.userModified).toEqual(INITIAL_USER_MODIFIED);
      expect(next.form).toEqual(state.form);
      expect(next.resolution.status).toBe("pending");
    });
  });

  describe("buildProviderDefinitionMap", () => {
    it("builds a map from provider id to definition", () => {
      const map = buildProviderDefinitionMap([TEST_CODEX_DEFINITION, TEST_CLAUDE_DEFINITION]);
      expect(map.get("codex")).toBe(TEST_CODEX_DEFINITION);
      expect(map.get("claude")).toBe(TEST_CLAUDE_DEFINITION);
    });
  });

  describe("buildProviderDefinitionMapForStatuses", () => {
    it("returns all definitions when no snapshot entries", () => {
      const map = buildProviderDefinitionMapForStatuses({
        snapshotEntries: undefined,
        providerDefinitions: [TEST_CODEX_DEFINITION],
        statuses: new Set(["ready"]),
      });
      expect([...map.keys()]).toEqual(["codex"]);
    });

    it("filters to only matching-status enabled providers", () => {
      const entries: ProviderSnapshotEntry[] = [
        {
          provider: "codex",
          status: "ready",
          enabled: true,
          label: "Codex",
          description: "",
          defaultModeId: "auto",
          modes: [],
        },
        {
          provider: "claude",
          status: "loading",
          enabled: true,
          label: "Claude",
          description: "",
          defaultModeId: "default",
          modes: [],
        },
      ];
      const map = buildProviderDefinitionMapForStatuses({
        snapshotEntries: entries,
        providerDefinitions: [TEST_CODEX_DEFINITION, TEST_CLAUDE_DEFINITION],
        statuses: new Set<ProviderSnapshotEntry["status"]>(["ready"]),
      });

      expect([...map.keys()]).toEqual(["codex"]);
    });
  });
});

it("owns input readiness, reopening and user edits in the reducer", () => {
  const inputs = {
    type: "INPUTS_CHANGED" as const,
    serverId: "host",
    isVisible: true,
    isCreateFlow: true,
    isPreferencesLoading: true,
    hasSnapshot: false,
    initialValues: undefined,
    preferences: { provider: "codex", providerPreferences: { codex: { model: "astra" } } },
    allowedProviderMap: new Map(),
    providerModelsByProvider: new Map(),
  };
  let state = resolveAgentForm(makeState(), inputs);
  expect(state.resolution.status).toBe("pending");
  state = resolveAgentForm(state, { ...inputs, isPreferencesLoading: false, hasSnapshot: true });
  expect(state.form).toMatchObject({ provider: "codex", model: "astra" });
  state = resolveAgentForm(state, {
    type: "SET_MODEL_FROM_USER",
    modelId: "manual",
    availableModels: null,
    providerPrefs: undefined,
  });
  state = resolveAgentForm(state, { ...inputs, isPreferencesLoading: false, hasSnapshot: true });
  expect(state.form.model).toBe("manual");
  state = resolveAgentForm(state, { ...inputs, isVisible: false });
  expect(state.resolution.status).toBe("pending");
  state = resolveAgentForm(state, { ...inputs, isPreferencesLoading: false, hasSnapshot: true });
  expect(state.form).toMatchObject({ provider: "codex", model: "astra" });
});

describe("Antigravity profiles and drafts saved with tiered model ids", () => {
  const orchestrator: AgentModelDefinition = {
    provider: "antigravity",
    id: "orchestrator",
    label: "Orchestrator",
    thinkingOptions: [],
  };
  const models = [...ANTIGRAVITY_MODELS, orchestrator];

  it("clears stale profile and draft thinking once the model declares no tiers", () => {
    const initialValues = {
      provider: orchestrator.provider,
      model: orchestrator.id,
      thinkingOptionId: "high",
    };
    const profile = {
      type: "APPLY_PROFILE_FROM_USER" as const,
      provider: orchestrator.provider,
      providerDef: undefined,
      modelId: orchestrator.id,
      modeId: "",
      thinkingOptionId: "high",
    };
    const draft = {
      type: "COMPLETE_RESOLUTION" as const,
      initialValues,
      preferences: null,
      allowedProviderMap: makeProviderMap(),
      providerModelsByProvider: makeProviderModelsByProvider([[orchestrator.provider, null]]),
    };
    const ready = {
      ...draft,
      providerModelsByProvider: makeProviderModelsByProvider([[orchestrator.provider, models]]),
    };
    const waiting = resolveAgentForm(makeState(), draft);
    const applied = resolveAgentForm(waiting, { ...profile, providerModels: null });
    for (const state of [waiting, applied]) {
      expect(state.form.thinkingOptionId).toBe("high");
      expect(resolveAgentForm(state, ready).form.thinkingOptionId).toBe("");
    }
    expect(resolveAgentForm(makeState(), ready).form.thinkingOptionId).toBe("");
    expect(
      resolveAgentForm(waiting, { ...profile, providerModels: models }).form.thinkingOptionId,
    ).toBe("");
  });

  it("drops the previous model's tier and a stale preference when switching models", () => {
    const state = makeState({
      provider: orchestrator.provider,
      model: ANTIGRAVITY_MODELS[0].id,
      thinkingOptionId: "high",
    });
    const next = resolveAgentForm(state, {
      type: "SET_MODEL_FROM_USER",
      modelId: orchestrator.id,
      availableModels: models,
      providerPrefs: { thinkingByModel: { [orchestrator.id]: "high" } },
    });
    expect(next.form).toMatchObject({ model: orchestrator.id, thinkingOptionId: "" });
  });

  it.each([
    ["gemini-4-neon-xhigh", "", "gemini-4-neon", "xhigh"],
    ["gemini-4-carbon-high", "", "gemini-4-carbon", "high"],
    ["claude-opus-5-5-high", "", "claude-opus-5-5", "high"],
    ["carbon-high", " low ", "gemini-4-carbon", "low"],
    ["carbon-high", "unavailable", "gemini-4-carbon", "high"],
    ["gemini-4-carbon-ultra", "", "gemini-4-neon", "high"],
    ["gemini-4-carbon-xhigh", "", "gemini-4-neon", "high"],
    ["gpt-oss-120b-medium", "", "gpt-oss-120b-medium", ""],
    ["gpt-oss-native-medium", "", "gpt-oss-120b-medium", ""],
  ])(
    "applies profile %s with explicit thinking %j",
    (modelId, thinkingOptionId, model, thinking) => {
      const state = resolveAgentForm(makeState(), {
        type: "APPLY_PROFILE_FROM_USER",
        provider: "antigravity",
        providerDef: undefined,
        providerModels: ANTIGRAVITY_MODELS,
        providerPrefs: { thinkingByModel: { "gemini-4-carbon": "low" } },
        modelId,
        modeId: "",
        thinkingOptionId,
      });

      expect(state.form).toMatchObject({ model, thinkingOptionId: thinking });
    },
  );

  const inputs = {
    type: "INPUTS_CHANGED" as const,
    serverId: "host",
    isVisible: true,
    isCreateFlow: true,
    isPreferencesLoading: false,
    hasSnapshot: true,
    initialValues: { provider: "antigravity", model: "gemini-4-carbon-high" },
    preferences: {
      provider: "antigravity",
      providerPreferences: { antigravity: { thinkingByModel: { "gemini-4-carbon": "low" } } },
    },
    providerModelsByProvider: makeProviderModelsByProvider([["antigravity", null]]),
    allowedProviderMap: makeProviderMap(),
  };
  const readyModels = makeProviderModelsByProvider([["antigravity", ANTIGRAVITY_MODELS]]);

  it.each([
    [undefined, "high"],
    ["low", "low"],
    ["unavailable", "high"],
  ])(
    "resolves draft thinking %j on opening or when the catalog arrives",
    (thinkingOptionId, thinking) => {
      const draft = { ...inputs, initialValues: { ...inputs.initialValues, thinkingOptionId } };
      const ready = { ...draft, providerModelsByProvider: readyModels };
      const waiting = resolveAgentForm(makeState(), draft);
      expect(waiting.form.model).toBe("gemini-4-carbon-high");
      expect(waiting.resolution.status).toBe("completed");
      const updated = resolveAgentForm(waiting, ready);
      expect(updated.form).toMatchObject({ model: "gemini-4-carbon", thinkingOptionId: thinking });
      expect(resolveAgentForm(makeState(), ready).form).toEqual(updated.form);
      expect(resolveAgentForm(updated, ready)).toBe(updated);
    },
  );

  it("resolves a profile applied before the directory lists any models", () => {
    const waiting = resolveAgentForm(makeState(), { ...inputs, initialValues: undefined });
    const profile = resolveAgentForm(waiting, {
      type: "APPLY_PROFILE_FROM_USER",
      provider: "antigravity",
      providerDef: undefined,
      providerModels: [],
      modelId: "gemini-4-carbon-high",
      modeId: "",
      thinkingOptionId: "low",
    });
    expect(profile.form).toMatchObject({ model: "gemini-4-carbon-high", thinkingOptionId: "low" });
    const ready = {
      ...inputs,
      initialValues: undefined,
      providerModelsByProvider: readyModels,
    };
    const updated = resolveAgentForm(profile, ready);
    expect(updated.form).toMatchObject({ model: "gemini-4-carbon", thinkingOptionId: "low" });
  });

  it("keeps a user model change when the saved model becomes recognizable", () => {
    const waiting = resolveAgentForm(makeState(), inputs);
    const edited = resolveAgentForm(waiting, {
      type: "SET_MODEL_FROM_USER",
      modelId: "gpt-oss-120b-medium",
      availableModels: null,
      providerPrefs: undefined,
    });
    expect(resolveAgentForm(edited, { ...inputs, providerModelsByProvider: readyModels })).toBe(
      edited,
    );
  });

  it.each(["gpt-oss-120b-medium", "gpt-oss-native-medium"])(
    "reconciles unsupported draft thinking when the full reference %s arrives",
    (model) => {
      const draft = {
        ...inputs,
        initialValues: { ...inputs.initialValues, model, thinkingOptionId: "medium" },
      };
      const waiting = resolveAgentForm(makeState(), draft);
      const ready = { ...draft, providerModelsByProvider: readyModels };
      const updated = resolveAgentForm(waiting, ready);

      expect(updated.form).toMatchObject({ model: "gpt-oss-120b-medium", thinkingOptionId: "" });
      expect(updated.form).toEqual(resolveAgentForm(makeState(), ready).form);
    },
  );
});
