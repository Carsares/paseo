import { describe, expect, it } from "vitest";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { resolveModelSheetOpening, toggleWorkspaceBatchModel } from "./model-sheet-flow";

function provider(id: string, label: string): ProviderSelectorProvider {
  return { id, label, modelSelection: { kind: "models", rows: [] } };
}

const codex = provider("codex", "Codex");
const claude = provider("claude", "Claude Code");

describe("model sheet opening", () => {
  it("starts drafts at providers even when only one provider is available", () => {
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: true,
        providers: [codex],
        selectedProvider: "codex",
      }),
    ).toEqual({ kind: "all" });
  });

  it("opens a running agent directly at its fixed provider", () => {
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: false,
        providers: [claude, codex],
        selectedProvider: "codex",
      }),
    ).toEqual({ kind: "provider", providerId: "codex", providerLabel: "Codex" });
  });

  it("falls back to the only provider while live state catches up", () => {
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: false,
        providers: [codex],
        selectedProvider: "",
      }),
    ).toEqual({ kind: "provider", providerId: "codex", providerLabel: "Codex" });
  });
});

it("caps the list at four, distinguishes providers, and lets users remove a selected model at the cap", () => {
  const models = [codex, claude, provider("pi", "Pi"), provider("muse", "Muse")].map(
    ({ id, label }) => ({
      provider: id,
      providerLabel: label,
      modelId: "default",
      modelLabel: "Default",
    }),
  );
  const fifth = { ...models[0]!, modelId: "another" };
  expect(toggleWorkspaceBatchModel({ models: models.slice(0, 3), model: models[3]! })).toEqual(
    models,
  );
  expect(toggleWorkspaceBatchModel({ models, model: fifth })).toBeNull();
  expect(toggleWorkspaceBatchModel({ models, model: models[1]! })).toEqual([
    models[0],
    models[2],
    models[3],
  ]);
  expect(toggleWorkspaceBatchModel({ models: [], model: fifth, disabled: true })).toBeNull();
});
