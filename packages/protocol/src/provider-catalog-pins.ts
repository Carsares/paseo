import semver from "semver";

export type FixedLauncherKind = "npx" | "npx-package" | "uvx-from";

export interface ProviderCatalogPin {
  readonly provider: string;
  readonly launcher: FixedLauncherKind;
  readonly packageName: string;
  readonly version: string;
  /** Required executable name when `launcher` is `"npx-package"` or `"uvx-from"`. */
  readonly executable?: string;
  /** Default arguments appended after the fixed launcher prefix when installing from the catalog. */
  readonly defaultArgs: readonly string[];
}

export interface ParsedFixedCatalogLauncher {
  readonly provider: string;
  readonly launcher: FixedLauncherKind;
  readonly packageName: string;
  readonly version: string;
  readonly executable?: string;
  /** Index inside `command` holding `<package>@<version>` or `<package>==<version>`. */
  readonly specIndex: number;
  /** Arguments following the fixed launcher prefix, preserved verbatim on pin updates. */
  readonly trailingArgs: readonly string[];
}

const MAX_PINNED_VERSION_LENGTH = 128;

// Exact npm semver pin only (no leading `v`, ranges, dist-tags, URLs, or whitespace).
const STRICT_NPM_PIN_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// Exact PEP 440 pin only (no wildcards, comparators, extras, or local/URL specifiers).
const STRICT_PEP440_PIN_VERSION_RE =
  /^(?:[1-9]\d*!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;

// Conservative comparable PEP 440 subset: numeric release tuple with at most one common tag
// (`.devN`, `aN`, `bN`, `rcN`, or `.postN`) and no epoch (`N!`) or compound tags.
const COMPARABLE_PEP440_VERSION_RE =
  /^(\d+(?:\.\d+)*)(?:(?:(a|b|rc)(\d+))|(?:\.(post)(\d+))|(?:\.(dev)(\d+)))?$/;

const PEP440_STAGE_RANK = {
  dev: 0,
  a: 1,
  b: 2,
  rc: 3,
  final: 4,
  post: 5,
} as const;

/**
 * Host-owned catalog of allowed fixed `npx`/`uvx` package pins and default install arguments.
 * Shared with the app so the UI and host enforce the same package identities, commands, and pins.
 */
export const PROVIDER_CATALOG_PINS: Readonly<Record<string, ProviderCatalogPin>> = {
  "agoragentic-acp": {
    provider: "agoragentic-acp",
    launcher: "npx",
    packageName: "agoragentic-mcp",
    version: "1.3.6",
    defaultArgs: ["--acp"],
  },
  auggie: {
    provider: "auggie",
    launcher: "npx",
    packageName: "@augmentcode/auggie",
    version: "0.36.0",
    defaultArgs: ["--acp"],
  },
  autohand: {
    provider: "autohand",
    launcher: "npx",
    packageName: "@autohandai/autohand-acp",
    version: "0.2.1",
    defaultArgs: [],
  },
  cline: {
    provider: "cline",
    launcher: "npx",
    packageName: "cline",
    version: "3.0.73",
    defaultArgs: ["--acp"],
  },
  deepagents: {
    provider: "deepagents",
    launcher: "npx",
    packageName: "deepagents-acp",
    version: "0.1.36",
    defaultArgs: [],
  },
  dimcode: {
    provider: "dimcode",
    launcher: "npx",
    packageName: "dimcode",
    version: "0.5.21",
    defaultArgs: ["acp"],
  },
  dirac: {
    provider: "dirac",
    launcher: "npx",
    packageName: "dirac-cli",
    version: "0.5.23",
    defaultArgs: ["--acp"],
  },
  "factory-droid": {
    provider: "factory-droid",
    launcher: "npx",
    packageName: "droid",
    version: "0.249.0",
    defaultArgs: ["exec", "--output-format", "acp-daemon"],
  },
  "fast-agent": {
    provider: "fast-agent",
    launcher: "uvx-from",
    packageName: "fast-agent-acp",
    version: "0.10.47",
    executable: "fast-agent-acp",
    defaultArgs: ["-x"],
  },
  gemini: {
    provider: "gemini",
    launcher: "npx",
    packageName: "@google/gemini-cli",
    version: "0.70.0",
    defaultArgs: ["--acp"],
  },
  "glm-acp-agent": {
    provider: "glm-acp-agent",
    launcher: "npx",
    packageName: "glm-acp-agent",
    version: "1.15.0",
    defaultArgs: [],
  },
  "minimax-code": {
    provider: "minimax-code",
    launcher: "npx-package",
    packageName: "@minimax-ai/code",
    version: "0.6.13",
    executable: "mcode",
    defaultArgs: ["acp"],
  },
  "minion-code": {
    provider: "minion-code",
    launcher: "uvx-from",
    packageName: "minion-code",
    version: "0.1.45",
    executable: "minion-code",
    defaultArgs: ["acp"],
  },
  nova: {
    provider: "nova",
    launcher: "npx",
    packageName: "@compass-ai/nova",
    version: "1.1.59",
    defaultArgs: ["acp"],
  },
  qoder: {
    provider: "qoder",
    launcher: "npx",
    packageName: "@qoder-ai/qodercli",
    version: "1.1.78",
    defaultArgs: ["--acp"],
  },
  "qwen-code": {
    provider: "qwen-code",
    launcher: "npx",
    packageName: "@qwen-code/qwen-code",
    version: "0.26.0",
    defaultArgs: ["--acp", "--experimental-skills"],
  },
};

export function getProviderCatalogPin(provider: string): ProviderCatalogPin | null {
  if (!Object.hasOwn(PROVIDER_CATALOG_PINS, provider)) return null;
  return PROVIDER_CATALOG_PINS[provider] ?? null;
}

export function isStrictPinnedVersion(launcher: FixedLauncherKind, version: string): boolean {
  if (version.length === 0 || version.length > MAX_PINNED_VERSION_LENGTH) return false;
  return launcher === "uvx-from"
    ? STRICT_PEP440_PIN_VERSION_RE.test(version)
    : STRICT_NPM_PIN_VERSION_RE.test(version);
}

export function formatFixedLauncherPackageSpec(
  pin: Pick<ProviderCatalogPin, "launcher" | "packageName">,
  version: string,
): string {
  return pin.launcher === "uvx-from"
    ? `${pin.packageName}==${version}`
    : `${pin.packageName}@${version}`;
}

/** Builds the canonical catalog install argv from the shared pin entry. */
export function buildProviderCatalogCommand(
  pin: ProviderCatalogPin,
): readonly [string, ...string[]] {
  const spec = formatFixedLauncherPackageSpec(pin, pin.version);
  if (pin.launcher === "npx") {
    return ["npx", "-y", spec, ...pin.defaultArgs];
  }
  if (pin.launcher === "npx-package") {
    return ["npx", "-y", "-p", spec, pin.executable ?? "", ...pin.defaultArgs];
  }
  return ["uvx", "--from", spec, pin.executable ?? "", ...pin.defaultArgs];
}

interface ParsedComparablePep440 {
  readonly release: readonly number[];
  readonly stageRank: number;
  readonly stageNumber: number;
}

function parseComparablePep440(version: string): ParsedComparablePep440 | null {
  const match = COMPARABLE_PEP440_VERSION_RE.exec(version);
  if (!match) return null;
  const release = match[1].split(".").map((segment) => Number(segment));
  if (release.some((segment) => !Number.isSafeInteger(segment))) return null;

  const preTag = match[2] as "a" | "b" | "rc" | undefined;
  const postTag = match[4];
  const devTag = match[6];
  let stageRank: number = PEP440_STAGE_RANK.final;
  let stageNumber = 0;

  if (preTag) {
    stageRank = PEP440_STAGE_RANK[preTag];
    stageNumber = Number(match[3]);
  } else if (postTag) {
    stageRank = PEP440_STAGE_RANK.post;
    stageNumber = Number(match[5]);
  } else if (devTag) {
    stageRank = PEP440_STAGE_RANK.dev;
    stageNumber = Number(match[7]);
  }
  if (!Number.isSafeInteger(stageNumber)) return null;

  return { release, stageRank, stageNumber };
}

function compareComparablePep440(left: string, right: string): number | null {
  const a = parseComparablePep440(left);
  const b = parseComparablePep440(right);
  if (!a || !b) return null;

  const length = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a.release[i] ?? 0) - (b.release[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.stageRank !== b.stageRank) return a.stageRank - b.stageRank;
  return a.stageNumber - b.stageNumber;
}

/**
 * Returns true only when `targetVersion` is strictly newer than `currentVersion`.
 * Uses `semver` for `npx` pins and a conservative comparable subset for `uvx` (PEP 440) pins,
 * returning false for downgrades, equal versions, or incomparable/unknown sequences.
 */
export function isCatalogPinUpgrade(
  launcher: FixedLauncherKind,
  currentVersion: string,
  targetVersion: string,
): boolean {
  if (
    !isStrictPinnedVersion(launcher, currentVersion) ||
    !isStrictPinnedVersion(launcher, targetVersion)
  ) {
    return false;
  }
  if (currentVersion === targetVersion) return false;

  if (launcher === "uvx-from") {
    const comparison = compareComparablePep440(targetVersion, currentVersion);
    return comparison !== null && comparison > 0;
  }

  const parsedCurrent = semver.valid(currentVersion);
  const parsedTarget = semver.valid(targetVersion);
  if (!parsedCurrent || !parsedTarget) return false;
  return semver.gt(parsedTarget, parsedCurrent);
}

interface FixedLauncherLayout {
  readonly specIndex: number;
  readonly trailingStart: number;
  readonly prefix: string;
}

function matchFixedLauncherLayout(
  pin: ProviderCatalogPin,
  command: readonly string[],
): FixedLauncherLayout | null {
  if (pin.launcher === "npx") {
    if (command.length < 3 || command[0] !== "npx" || command[1] !== "-y") return null;
    return { specIndex: 2, trailingStart: 3, prefix: `${pin.packageName}@` };
  }
  if (!pin.executable) return null;
  if (pin.launcher === "npx-package") {
    const matches =
      command.length >= 5 &&
      command[0] === "npx" &&
      command[1] === "-y" &&
      command[2] === "-p" &&
      command[4] === pin.executable;
    return matches ? { specIndex: 3, trailingStart: 5, prefix: `${pin.packageName}@` } : null;
  }
  const matches =
    command.length >= 4 &&
    command[0] === "uvx" &&
    command[1] === "--from" &&
    command[3] === pin.executable;
  return matches ? { specIndex: 2, trailingStart: 4, prefix: `${pin.packageName}==` } : null;
}

/**
 * Strictly parses a configured command against the catalog's standard fixed `npx`/`uvx` shape.
 * Read-only: never executes anything, rejects non-standard flags or mismatched packages, and
 * records trailing arguments so callers can preserve them verbatim.
 */
export function parseFixedCatalogLauncher(
  provider: string,
  command: readonly string[] | undefined,
): ParsedFixedCatalogLauncher | null {
  const pin = getProviderCatalogPin(provider);
  if (!pin || !command || command.length === 0) return null;

  const layout = matchFixedLauncherLayout(pin, command);
  if (!layout) return null;

  const specToken = command[layout.specIndex];
  if (!specToken || !specToken.startsWith(layout.prefix)) return null;
  const version = specToken.slice(layout.prefix.length);
  if (!isStrictPinnedVersion(pin.launcher, version)) return null;

  return {
    provider: pin.provider,
    launcher: pin.launcher,
    packageName: pin.packageName,
    version,
    ...(pin.executable ? { executable: pin.executable } : {}),
    specIndex: layout.specIndex,
    trailingArgs: command.slice(layout.trailingStart),
  };
}

/**
 * Replaces only the fixed package version token in a validated launcher command,
 * preserving every other argument in exact order.
 */
export function replaceFixedCatalogLauncherVersion(
  parsed: ParsedFixedCatalogLauncher,
  command: readonly string[],
  nextVersion: string,
): string[] | null {
  if (!isStrictPinnedVersion(parsed.launcher, nextVersion)) return null;
  if (parsed.specIndex < 0 || parsed.specIndex >= command.length) return null;
  const nextCommand = [...command];
  nextCommand[parsed.specIndex] = formatFixedLauncherPackageSpec(parsed, nextVersion);
  return nextCommand;
}
