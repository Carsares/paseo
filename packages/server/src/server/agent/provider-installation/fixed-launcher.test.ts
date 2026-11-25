import { describe, expect, it } from "vitest";
import {
  getCatalogPinSpec,
  parseFixedLauncherCommand,
  PROVIDER_CATALOG_PINS,
  resolveFixedLauncherUpdate,
} from "./fixed-launcher.js";

describe("fixed-launcher", () => {
  it("updates standard npx direct pin and preserves trailing arguments", () => {
    const target = getCatalogPinSpec("gemini")!.version;
    const result = resolveFixedLauncherUpdate({
      provider: "gemini",
      command: ["npx", "-y", "@google/gemini-cli@0.68.0", "--acp", "--model", "gemini-2.5-pro"],
      expectedVersion: "0.68.0",
      version: target,
    });

    expect(result).toEqual({
      status: "updated",
      command: ["npx", "-y", `@google/gemini-cli@${target}`, "--acp", "--model", "gemini-2.5-pro"],
      previousVersion: "0.68.0",
      version: target,
      packageName: "@google/gemini-cli",
      launcher: "npx",
    });
  });

  it("updates standard npx -p pin and preserves executable and trailing arguments", () => {
    const target = getCatalogPinSpec("minimax-code")!.version;
    const result = resolveFixedLauncherUpdate({
      provider: "minimax-code",
      command: ["npx", "-y", "-p", "@minimax-ai/code@0.6.10", "mcode", "acp", "--debug"],
      expectedVersion: "0.6.10",
      version: target,
    });

    expect(result).toEqual({
      status: "updated",
      command: ["npx", "-y", "-p", `@minimax-ai/code@${target}`, "mcode", "acp", "--debug"],
      previousVersion: "0.6.10",
      version: target,
      packageName: "@minimax-ai/code",
      launcher: "npx-package",
    });
  });

  it("updates standard uvx --from pin and preserves executable and trailing arguments", () => {
    const target = getCatalogPinSpec("fast-agent")!.version;
    const result = resolveFixedLauncherUpdate({
      provider: "fast-agent",
      command: ["uvx", "--from", "fast-agent-acp==0.10.40", "fast-agent-acp", "-x", "--quiet"],
      expectedVersion: "0.10.40",
      version: target,
    });

    expect(result).toEqual({
      status: "updated",
      command: ["uvx", "--from", `fast-agent-acp==${target}`, "fast-agent-acp", "-x", "--quiet"],
      previousVersion: "0.10.40",
      version: target,
      packageName: "fast-agent-acp",
      launcher: "uvx-from",
    });
  });

  it("returns conflict when expectedVersion does not match the configured pin", () => {
    const target = getCatalogPinSpec("cline")!.version;
    expect(
      resolveFixedLauncherUpdate({
        provider: "cline",
        command: ["npx", "-y", "cline@3.0.70", "--acp"],
        expectedVersion: "3.0.69",
        version: target,
      }),
    ).toEqual({
      status: "conflict",
      currentVersion: "3.0.70",
      expectedVersion: "3.0.69",
    });
  });

  it("returns conflict when configured command is already on the target pin", () => {
    const target = getCatalogPinSpec("cline")!.version;
    expect(
      resolveFixedLauncherUpdate({
        provider: "cline",
        command: ["npx", "-y", `cline@${target}`, "--acp"],
        expectedVersion: target,
        version: target,
      }),
    ).toEqual({
      status: "conflict",
      currentVersion: target,
      expectedVersion: target,
    });
  });

  it("rejects unknown providers and unapproved target versions", () => {
    expect(
      resolveFixedLauncherUpdate({
        provider: "custom-unknown",
        command: ["npx", "-y", "custom-pkg@1.0.0"],
        expectedVersion: "1.0.0",
        version: "1.0.1",
      }),
    ).toEqual({ status: "unsupported", reason: "unknown_provider" });

    expect(
      resolveFixedLauncherUpdate({
        provider: "gemini",
        command: ["npx", "-y", "@google/gemini-cli@0.68.0", "--acp"],
        expectedVersion: "0.68.0",
        version: "9.9.9",
      }),
    ).toEqual({ status: "unsupported", reason: "unapproved_version" });
  });

  it("rejects non-standard commands, swapped packages, and non-exact pins", () => {
    const target = getCatalogPinSpec("gemini")!.version;
    const invalidCommands: Array<string[] | undefined> = [
      undefined,
      [],
      ["gemini", "--acp"],
      ["npx", "@google/gemini-cli@0.68.0", "--acp"],
      ["npx", "-y", "--quiet", "@google/gemini-cli@0.68.0", "--acp"],
      ["npx", "-y", "@evil/gemini-cli@0.68.0", "--acp"],
      ["npx", "-y", "@google/gemini-cli@latest", "--acp"],
      ["npx", "-y", "@google/gemini-cli@^0.68.0", "--acp"],
    ];

    for (const command of invalidCommands) {
      expect(parseFixedLauncherCommand("gemini", command)).toBeNull();
      expect(
        resolveFixedLauncherUpdate({
          provider: "gemini",
          command,
          expectedVersion: "0.68.0",
          version: target,
        }),
      ).toEqual({ status: "unsupported", reason: "non_standard_command" });
    }
  });

  it("rejects downgrades to an earlier catalog pin and incomparable PEP 440 versions", () => {
    const geminiTarget = getCatalogPinSpec("gemini")!.version;
    expect(
      resolveFixedLauncherUpdate({
        provider: "gemini",
        command: ["npx", "-y", "@google/gemini-cli@9.0.0", "--acp"],
        expectedVersion: "9.0.0",
        version: geminiTarget,
      }),
    ).toEqual({ status: "unsupported", reason: "not_an_upgrade" });

    const fastAgentTarget = getCatalogPinSpec("fast-agent")!.version;
    expect(
      resolveFixedLauncherUpdate({
        provider: "fast-agent",
        command: ["uvx", "--from", "fast-agent-acp==9.0.0", "fast-agent-acp", "-x"],
        expectedVersion: "9.0.0",
        version: fastAgentTarget,
      }),
    ).toEqual({ status: "unsupported", reason: "not_an_upgrade" });

    expect(
      resolveFixedLauncherUpdate({
        provider: "fast-agent",
        command: ["uvx", "--from", "fast-agent-acp==1!0.1.0", "fast-agent-acp", "-x"],
        expectedVersion: "1!0.1.0",
        version: fastAgentTarget,
      }),
    ).toEqual({ status: "unsupported", reason: "not_an_upgrade" });
  });

  it("covers all host-owned catalog pins", () => {
    expect(Object.keys(PROVIDER_CATALOG_PINS).length).toBe(16);
  });
});
