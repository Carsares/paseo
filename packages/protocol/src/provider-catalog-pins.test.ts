import { describe, expect, it } from "vitest";
import {
  buildProviderCatalogCommand,
  formatFixedLauncherPackageSpec,
  getProviderCatalogPin,
  isCatalogPinUpgrade,
  isStrictPinnedVersion,
  parseFixedCatalogLauncher,
  PROVIDER_CATALOG_PINS,
  replaceFixedCatalogLauncherVersion,
} from "./provider-catalog-pins.js";

describe("provider-catalog-pins", () => {
  it("declares valid strict versions and executables for every catalog pin", () => {
    const entries = Object.values(PROVIDER_CATALOG_PINS);
    expect(entries.length).toBe(16);

    for (const pin of entries) {
      expect(getProviderCatalogPin(pin.provider)).toEqual(pin);
      expect(isStrictPinnedVersion(pin.launcher, pin.version)).toBe(true);
      if (pin.launcher === "npx-package" || pin.launcher === "uvx-from") {
        expect(pin.executable).toBeTruthy();
      }
    }
  });

  it("ignores unknown providers and Object.prototype keys", () => {
    expect(getProviderCatalogPin("nonexistent")).toBeNull();
    expect(getProviderCatalogPin("toString")).toBeNull();
    expect(getProviderCatalogPin("__proto__")).toBeNull();
  });

  it("parses standard npx, npx -p, and uvx --from commands while preserving trailing args", () => {
    expect(
      parseFixedCatalogLauncher("gemini", [
        "npx",
        "-y",
        "@google/gemini-cli@0.68.0",
        "--acp",
        "--custom-flag",
        "value",
      ]),
    ).toEqual({
      provider: "gemini",
      launcher: "npx",
      packageName: "@google/gemini-cli",
      version: "0.68.0",
      specIndex: 2,
      trailingArgs: ["--acp", "--custom-flag", "value"],
    });

    expect(
      parseFixedCatalogLauncher("minimax-code", [
        "npx",
        "-y",
        "-p",
        "@minimax-ai/code@0.6.10",
        "mcode",
        "acp",
        "--verbose",
      ]),
    ).toEqual({
      provider: "minimax-code",
      launcher: "npx-package",
      packageName: "@minimax-ai/code",
      version: "0.6.10",
      executable: "mcode",
      specIndex: 3,
      trailingArgs: ["acp", "--verbose"],
    });

    expect(
      parseFixedCatalogLauncher("fast-agent", [
        "uvx",
        "--from",
        "fast-agent-acp==0.10.40",
        "fast-agent-acp",
        "-x",
        "--model",
        "sonnet",
      ]),
    ).toEqual({
      provider: "fast-agent",
      launcher: "uvx-from",
      packageName: "fast-agent-acp",
      version: "0.10.40",
      executable: "fast-agent-acp",
      specIndex: 2,
      trailingArgs: ["-x", "--model", "sonnet"],
    });
  });

  it("rejects non-standard launcher shapes, mismatched packages, and non-exact versions", () => {
    const rejected: Array<[string, string[]]> = [
      ["gemini", ["npx", "@google/gemini-cli@0.68.0", "--acp"]],
      ["gemini", ["npx", "--yes", "@google/gemini-cli@0.68.0", "--acp"]],
      ["gemini", ["/usr/local/bin/npx", "-y", "@google/gemini-cli@0.68.0", "--acp"]],
      ["gemini", ["npx", "-y", "--registry=https://example.com", "@google/gemini-cli@0.68.0"]],
      ["gemini", ["npx", "-y", "@other/gemini-cli@0.68.0", "--acp"]],
      ["gemini", ["npx", "-y", "@google/gemini-cli@latest", "--acp"]],
      ["gemini", ["npx", "-y", "@google/gemini-cli@^0.68.0", "--acp"]],
      ["gemini", ["npx", "-y", "@google/gemini-cli@v0.68.0", "--acp"]],
      ["minimax-code", ["npx", "-y", "@minimax-ai/code@0.6.10", "acp"]],
      ["minimax-code", ["npx", "-y", "-p", "@minimax-ai/code@0.6.10", "other-bin", "acp"]],
      ["fast-agent", ["uvx", "fast-agent-acp==0.10.40", "-x"]],
      ["fast-agent", ["uvx", "--from", "fast-agent-acp>=0.10.40", "fast-agent-acp", "-x"]],
      ["fast-agent", ["uvx", "--from", "fast-agent-acp==0.10.*", "fast-agent-acp", "-x"]],
      ["fast-agent", ["uvx", "--from", "fast-agent-acp==0.10.40", "wrong-bin", "-x"]],
    ];

    for (const [provider, command] of rejected) {
      expect(parseFixedCatalogLauncher(provider, command)).toBeNull();
    }
  });

  it("replaces only the version token and keeps all other arguments intact", () => {
    const command = [
      "npx",
      "-y",
      "@qwen-code/qwen-code@0.25.0",
      "--acp",
      "--experimental-skills",
      "--extra",
    ];
    const parsed = parseFixedCatalogLauncher("qwen-code", command);
    expect(parsed).not.toBeNull();
    expect(replaceFixedCatalogLauncherVersion(parsed!, command, "0.26.0")).toEqual([
      "npx",
      "-y",
      "@qwen-code/qwen-code@0.26.0",
      "--acp",
      "--experimental-skills",
      "--extra",
    ]);
    expect(formatFixedLauncherPackageSpec(parsed!, "0.26.0")).toBe("@qwen-code/qwen-code@0.26.0");
  });

  it("builds canonical catalog commands that round-trip through parseFixedCatalogLauncher", () => {
    for (const pin of Object.values(PROVIDER_CATALOG_PINS)) {
      const command = buildProviderCatalogCommand(pin);
      const parsed = parseFixedCatalogLauncher(pin.provider, command);
      expect(parsed).toEqual({
        provider: pin.provider,
        launcher: pin.launcher,
        packageName: pin.packageName,
        version: pin.version,
        ...(pin.executable ? { executable: pin.executable } : {}),
        specIndex: pin.launcher === "npx-package" ? 3 : 2,
        trailingArgs: pin.defaultArgs,
      });
    }
  });

  it("only allows upgrades and conservatively rejects downgrades or incomparable PEP 440 versions", () => {
    // npm semver
    expect(isCatalogPinUpgrade("npx", "0.68.0", "0.70.0")).toBe(true);
    expect(isCatalogPinUpgrade("npx", "0.70.0-beta.1", "0.70.0")).toBe(true);
    expect(isCatalogPinUpgrade("npx", "0.70.0", "0.68.0")).toBe(false);
    expect(isCatalogPinUpgrade("npx", "0.70.0", "0.70.0")).toBe(false);
    expect(isCatalogPinUpgrade("npx-package", "0.6.13", "0.6.10")).toBe(false);

    // Python PEP 440 common comparable sequences
    expect(isCatalogPinUpgrade("uvx-from", "0.10.9", "0.10.47")).toBe(true);
    expect(isCatalogPinUpgrade("uvx-from", "0.10.47rc1", "0.10.47")).toBe(true);
    expect(isCatalogPinUpgrade("uvx-from", "0.10.47", "0.10.47.post1")).toBe(true);
    expect(isCatalogPinUpgrade("uvx-from", "0.10.47", "0.10.40")).toBe(false);
    expect(isCatalogPinUpgrade("uvx-from", "0.10.47", "0.10.47rc1")).toBe(false);
    expect(isCatalogPinUpgrade("uvx-from", "0.10.47", "0.10.47")).toBe(false);

    // Conservative rejection of epoch or compound PEP 440 forms
    expect(isCatalogPinUpgrade("uvx-from", "1!0.1.0", "0.10.47")).toBe(false);
    expect(isCatalogPinUpgrade("uvx-from", "0.10.47a1.dev0", "0.10.47")).toBe(false);
  });
});
