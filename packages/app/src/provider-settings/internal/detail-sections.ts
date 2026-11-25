import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { ProviderInstallationState } from "@/components/provider-installation-section";
import {
  readConfiguredCatalogPinStatus,
  type ConfiguredCatalogPinStatus,
} from "@/hooks/use-acp-provider-catalog";

export interface DetailSections {
  /** The failure the page leads with, or null. Empty when the provider gave no message. */
  error: string | null;
  /**
   * Which models the page lists. The provider reports its own only while it runs; custom models
   * live in config, so they stay manageable while it fails.
   */
  models: "all" | "custom" | null;
}

/** Which of the detail's state-dependent parts show, so each fact is said once. */
export function readDetailSections(
  entry: ProviderSnapshotEntry,
  installation: ProviderInstallationState,
): DetailSections {
  const notInstalled =
    entry.status === "unavailable" ||
    (installation.status === "ready" &&
      installation.installation?.inspection?.status === "not_installed");
  const failing = entry.enabled && entry.status === "error" && !notInstalled;
  return {
    error: failing ? (entry.error?.trim() ?? "") : null,
    models: readShownModels(entry, notInstalled),
  };
}

function readShownModels(
  entry: ProviderSnapshotEntry,
  notInstalled: boolean,
): DetailSections["models"] {
  if (!entry.enabled || notInstalled) return null;
  return entry.status === "error" ? "custom" : "all";
}

/**
 * The installation the page shows. A provider added from the catalog has no installation the
 * host can report, so when its CLI is missing the page says so with the catalog's install guide.
 * The host's own install link wins over the guide. A host that cannot report installations gets
 * the same row, because the guide is the app's own catalog data.
 */
export function readShownInstallation(input: {
  entry: ProviderSnapshotEntry;
  installation: ProviderInstallationState;
  /** The catalog's install guide for this provider, or null. */
  installGuide: string | null;
}): ProviderInstallationState {
  const { entry, installation, installGuide } = input;
  if (!installGuide) return installation;
  if (installation.status !== "ready" && installation.status !== "unsupported") return installation;
  const reported = installation.status === "ready" ? installation.installation : null;
  if (reported?.installUrl) return installation;
  const notInstalled =
    reported?.inspection?.status === "not_installed" ||
    (!reported?.inspection && entry.enabled && entry.status === "unavailable");
  if (!notInstalled) return installation;
  return {
    status: "ready",
    installation: {
      ...reported,
      inspection: { status: "not_installed" },
      installUrl: installGuide,
    },
  };
}

export type DetailPresence =
  | { kind: "found"; entry: ProviderSnapshotEntry }
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "offline" }
  | { kind: "failed"; message: string };

/**
 * Whether the page has a provider to show. A page opened from its URL renders before the host's
 * providers arrive, and its id may name a provider the host no longer has. A provider this page is
 * removing leaves the list before the removal answers; the page keeps showing it until it closes.
 */
export function readDetailPresence(input: {
  provider: string;
  connected: boolean;
  entries: ProviderSnapshotEntry[] | undefined;
  error: string | null;
  /** The provider this page's own Remove is deleting, as it was when the user confirmed. */
  removing: ProviderSnapshotEntry | null;
}): DetailPresence {
  const entry =
    input.entries?.find((candidate) => candidate.provider === input.provider) ??
    (input.removing?.provider === input.provider ? input.removing : undefined);
  if (entry) return { kind: "found", entry };
  if (!input.connected) return { kind: "offline" };
  if (input.entries) return { kind: "missing" };
  if (input.error) return { kind: "failed", message: input.error };
  return { kind: "loading" };
}

function readCommandArgv(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item): item is string => typeof item === "string") ? value : undefined;
}

/**
 * Resolves whether a configured ACP catalog provider has an outdated fixed `npx`/`uvx` pin
 * that the host can update. Gated on `features.providerCatalogPinUpdates` so older hosts never
 * show the action or receive the request.
 */
export function readCatalogPinUpdateTarget(input: {
  entry: ProviderSnapshotEntry;
  config: Pick<MutableDaemonConfig, "providers"> | null;
  supportsCatalogPinUpdates: boolean;
}): ConfiguredCatalogPinStatus | null {
  if (!input.supportsCatalogPinUpdates || input.entry.source !== "custom") return null;
  const configured = input.config?.providers?.[input.entry.provider];
  if (!configured || configured.extends !== "acp") return null;
  const status = readConfiguredCatalogPinStatus(
    input.entry.provider,
    readCommandArgv(configured.command),
  );
  if (!status || !status.updateAvailable) return null;
  return status;
}
