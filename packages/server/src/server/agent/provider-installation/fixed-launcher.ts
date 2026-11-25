import {
  getProviderCatalogPin,
  isCatalogPinUpgrade,
  parseFixedCatalogLauncher,
  PROVIDER_CATALOG_PINS,
  replaceFixedCatalogLauncherVersion,
  type FixedLauncherKind,
  type ParsedFixedCatalogLauncher,
  type ProviderCatalogPin,
} from "@getpaseo/protocol/provider-catalog-pins";

export { PROVIDER_CATALOG_PINS };
export type { FixedLauncherKind, ParsedFixedCatalogLauncher, ProviderCatalogPin };

export interface FixedLauncherUpdateInput {
  provider: string;
  command: readonly string[] | undefined;
  expectedVersion: string;
  version: string;
}

export type FixedLauncherUpdateResolution =
  | {
      status: "updated";
      command: string[];
      previousVersion: string;
      version: string;
      packageName: string;
      launcher: FixedLauncherKind;
    }
  | {
      status: "conflict";
      currentVersion: string;
      expectedVersion: string;
    }
  | {
      status: "unsupported";
      reason: "unknown_provider" | "unapproved_version" | "non_standard_command" | "not_an_upgrade";
    };

/** Returns the host-owned catalog pin specification for a provider, or null if not pinned. */
export function getCatalogPinSpec(provider: string): ProviderCatalogPin | null {
  return getProviderCatalogPin(provider);
}

/**
 * Strictly parses a provider's configured command against the host-owned fixed `npx`/`uvx` shape.
 * Read-only: never spawns a process or downloads packages.
 */
export function parseFixedLauncherCommand(
  provider: string,
  command: readonly string[] | undefined,
): ParsedFixedCatalogLauncher | null {
  return parseFixedCatalogLauncher(provider, command);
}

/**
 * Resolves a compare-and-swap catalog pin update for a configured ACP launcher command.
 * Enforces that:
 * - `provider` exists in the host-owned catalog pin table
 * - `version` equals the host-owned target pin for `provider`
 * - `command` strictly matches the standard fixed `npx`/`uvx` structure for the same package
 * - `expectedVersion` equals the currently configured pinned version
 * - `version` is strictly newer than the currently configured version (never downgrades)
 * Returns the rewritten argv preserving all other arguments verbatim, or a typed rejection.
 */
export function resolveFixedLauncherUpdate(
  input: FixedLauncherUpdateInput,
): FixedLauncherUpdateResolution {
  const spec = getProviderCatalogPin(input.provider);
  if (!spec) {
    return { status: "unsupported", reason: "unknown_provider" };
  }

  if (input.version !== spec.version) {
    return { status: "unsupported", reason: "unapproved_version" };
  }

  const parsed = parseFixedCatalogLauncher(input.provider, input.command);
  if (!parsed) {
    return { status: "unsupported", reason: "non_standard_command" };
  }

  if (parsed.version !== input.expectedVersion || parsed.version === input.version) {
    return {
      status: "conflict",
      currentVersion: parsed.version,
      expectedVersion: input.expectedVersion,
    };
  }

  if (!isCatalogPinUpgrade(parsed.launcher, parsed.version, input.version)) {
    return { status: "unsupported", reason: "not_an_upgrade" };
  }

  const nextCommand = replaceFixedCatalogLauncherVersion(
    parsed,
    input.command ?? [],
    input.version,
  );
  if (!nextCommand) {
    return { status: "unsupported", reason: "unapproved_version" };
  }

  return {
    status: "updated",
    command: nextCommand,
    previousVersion: parsed.version,
    version: input.version,
    packageName: parsed.packageName,
    launcher: parsed.launcher,
  };
}
