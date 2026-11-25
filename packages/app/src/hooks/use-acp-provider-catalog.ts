import { useCallback, useState } from "react";
import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import {
  getProviderCatalogPin,
  isCatalogPinUpgrade,
  parseFixedCatalogLauncher,
  type FixedLauncherKind,
  type ProviderCatalogPin,
} from "@getpaseo/protocol/provider-catalog-pins";
import { ACP_PROVIDER_CATALOG, type AcpProviderCatalogEntry } from "@/data/acp-provider-catalog";
import type { HostFeatureName } from "@/runtime/host-features";

export type AcpProviderCatalogItem = AcpProviderCatalogEntry;

export interface ConfiguredCatalogPinStatus {
  readonly provider: string;
  readonly packageName: string;
  readonly launcher: FixedLauncherKind;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly updateAvailable: boolean;
}

export function getAcpProviderCatalog(): AcpProviderCatalogItem[] {
  return ACP_PROVIDER_CATALOG;
}

/** The catalog's install guide for a provider added from it, or null for any other provider. */
export function readAcpProviderInstallGuide(provider: string): string | null {
  return ACP_PROVIDER_CATALOG.find((entry) => entry.id === provider)?.installLink ?? null;
}

/** The catalog's fixed launcher pin spec for a provider, or null if not a pinned npx/uvx entry. */
export function readAcpProviderCatalogPin(provider: string): ProviderCatalogPin | null {
  return getProviderCatalogPin(provider);
}

/**
 * Pure read-only inspection of a configured command against the catalog's fixed `npx`/`uvx` pin.
 * Returns null when the provider has no catalog pin or the command does not strictly match.
 */
export function readConfiguredCatalogPinStatus(
  provider: string,
  command: readonly string[] | undefined,
): ConfiguredCatalogPinStatus | null {
  const pin = getProviderCatalogPin(provider);
  if (!pin) return null;
  const parsed = parseFixedCatalogLauncher(provider, command);
  if (!parsed) return null;
  return {
    provider: pin.provider,
    packageName: parsed.packageName,
    launcher: parsed.launcher,
    currentVersion: parsed.version,
    targetVersion: pin.version,
    updateAvailable: isCatalogPinUpgrade(parsed.launcher, parsed.version, pin.version),
  };
}

export function buildAcpProviderConfigPatch(
  entry: AcpProviderCatalogItem,
  hostSupports: (feature: HostFeatureName) => boolean = () => false,
): MutableDaemonConfigPatch {
  if (entry.bundledProvider) {
    const feature = entry.bundledProvider.hostFeature;
    if (hostSupports(feature)) {
      return { providers: { [entry.id]: { enabled: true } } };
    }
    // COMPAT(gooseProvider): added in v0.17.0, remove after 2027-05-20 once host floor includes the bundled adapter.
    // COMPAT(hopliteProvider): added after v0.11.2, remove after 2027-04-15 once host floor includes the bundled adapter.
    // COMPAT(fxProvider): added after v0.15.3, remove after 2027-05-09 once host floor includes the bundled adapter.
    if (feature !== "gooseProvider") {
      throw new Error(`Update the host to add ${entry.title}.`);
    }
  }
  return {
    providers: {
      [entry.id]: {
        extends: "acp",
        label: entry.title,
        description: entry.description,
        command: [...entry.command],
        env: entry.env ? { ...entry.env } : {},
        ...(entry.params ? { params: { ...entry.params } } : {}),
      },
    },
  };
}

export function useAcpProviderCatalog() {
  const [entries] = useState<AcpProviderCatalogItem[]>(ACP_PROVIDER_CATALOG);

  const refetch = useCallback(async () => entries, [entries]);

  return { entries, loading: false, error: null, refetch };
}
