import { isDeepStrictEqual } from "node:util";
import {
  loadPersistedConfig,
  savePersistedConfigAsync,
  loadPersistedConfigAsync,
  type PersistedConfig,
} from "./persisted-config.js";
import { ProviderOverrideSchema } from "./agent/provider-launch-config.js";
import {
  convertLegacyClaudeUltracode,
  convertLegacyOptions,
  foldProfileFeatureValues,
  resolveAdapter,
  withLegacyProfileFeatureValues,
} from "./agent/option-controls.js";
import type { AgentProfile } from "@getpaseo/protocol/agent-profile";
import {
  MutableDaemonConfigSchema,
  MutableDaemonConfigPatchSchema,
} from "@getpaseo/protocol/messages";
import type { AgentSkillSelection } from "@getpaseo/protocol/messages";
import type { SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";
import { mergeSpeechSettingsPatch, type SpeechSettingsOwner } from "./speech/speech-settings.js";

export type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

type MutableDaemonConfig = import("@getpaseo/protocol/messages").MutableDaemonConfig;
type MutableDaemonConfigPatch = import("@getpaseo/protocol/messages").MutableDaemonConfigPatch;
type ProviderOverride = import("./agent/provider-launch-config.js").ProviderOverride;

interface SupportedMutableConfigPatch {
  relay?: { enabled?: boolean; requireProtectedSecurity?: boolean };
  mcp?: { injectIntoAgents?: boolean };
  usage?: { enabled: boolean };
  browserTools?: { enabled?: boolean };
  providers?: MutableDaemonConfig["providers"];
  removeProviders?: string[];
  metadataGeneration?: MutableDaemonConfig["metadataGeneration"];
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  idleRuntimeCleanup?: boolean;
  resumeOnStartup?: boolean;
  resumePrompt?: string;
  appendSystemPrompt?: string;
  mainControlAppendSystemPrompt?: string;
  terminalProfiles?: MutableDaemonConfig["terminalProfiles"];
  agentProfiles?: MutableDaemonConfig["agentProfiles"];
  skills?: MutableDaemonConfig["skills"];
  pluginsEnabled?: boolean;
  plugins?: MutableDaemonConfig["plugins"];
  features?: SpeechSettingsPatch;
}

const SPEECH_PERSISTED_PATHS = ["features.dictation", "features.voiceMode"];

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
}

export interface DaemonConfigChangeDetails {
  removedProviders: readonly string[];
}

export interface DaemonConfigReloadResult {
  appliedPaths: string[];
  restartRequiredPaths: string[];
  overrideControlledPaths: string[];
}

export interface DaemonConfigReloadSource {
  resolve(persisted: PersistedConfig): {
    mutable: MutableDaemonConfig;
    overrideControlledPaths: readonly string[];
  };
}

type ConfigListener = (config: MutableDaemonConfig, details: DaemonConfigChangeDetails) => void;
type ConfigApplyRollback = () => void;
type ConfigApplyListener = (
  config: MutableDaemonConfig,
  previous: MutableDaemonConfig,
  details: DaemonConfigChangeDetails,
) => ConfigApplyRollback;
type FieldChangeHandler = (value: unknown) => void;

interface AppliedFieldChange {
  handler: FieldChangeHandler;
  previousValue: unknown;
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "daemon-config-store" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(
  current: T,
  patch: Record<string, unknown>,
): T {
  const next: Record<string, unknown> = { ...current };

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) {
      continue;
    }
    const currentValue = next[key];
    if (isRecord(currentValue) && isRecord(patchValue)) {
      next[key] = deepMerge(currentValue, patchValue);
      continue;
    }
    next[key] = patchValue;
  }

  return next as T;
}

function omitProvidersFromConfig<T extends { providers?: Record<string, unknown> }>(
  config: T,
  providers: readonly string[],
): T {
  if (providers.length === 0 || !config.providers) {
    return config;
  }

  let changed = false;
  const nextProviders = { ...config.providers };
  for (const provider of providers) {
    if (provider in nextProviders) {
      delete nextProviders[provider];
      changed = true;
    }
  }

  return changed ? ({ ...config, providers: nextProviders } as T) : config;
}

function omitMetadataGenerationProvidersFromConfig<
  T extends { metadataGeneration?: { providers?: Array<{ provider?: unknown }> } },
>(config: T, providers: readonly string[]): T {
  if (providers.length === 0 || !config.metadataGeneration?.providers) {
    return config;
  }

  const removedProviderIds = new Set(providers);
  const nextProviders = config.metadataGeneration.providers.filter((entry) => {
    return typeof entry.provider !== "string" || !removedProviderIds.has(entry.provider);
  });
  if (nextProviders.length === config.metadataGeneration.providers.length) {
    return config;
  }

  return {
    ...config,
    metadataGeneration: {
      ...config.metadataGeneration,
      providers: nextProviders,
    },
  } as T;
}

function omitProvidersFromOverrides(
  overrides: Record<string, ProviderOverride> | undefined,
  providers: readonly string[],
): Record<string, ProviderOverride> | undefined {
  if (!overrides) {
    return undefined;
  }

  const nextOverrides = { ...overrides };
  for (const provider of providers) {
    delete nextOverrides[provider];
  }

  return Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined;
}

/**
 * Profiles are held and persisted with `options` only, in the current keys: a profile is old
 * data entering, so it is converted for the adapter its provider runs on, which `config.json`'s
 * `providers` section names through `extends`.
 */
function foldConfigProfiles<T extends { agentProfiles?: AgentProfile[] }>(input: {
  config: T;
  providers: Record<string, ProviderOverride> | undefined;
  source: "stored" | "client write";
  held?: AgentProfile[];
}): T {
  const { config, providers, source, held = [] } = input;
  if (!config.agentProfiles) return config;
  const convert = (provider: string, options: Record<string, unknown> | undefined) =>
    convertLegacyOptions({
      provider: resolveAdapter({ provider, extendsOf: (id) => providers?.[id]?.extends }),
      options,
    });
  const identity = (_provider: string, options: Record<string, unknown> | undefined) => options;
  const foldWith = (profile: AgentProfile, convertWith: typeof convert) => {
    const folded = foldProfileFeatureValues<
      Pick<AgentProfile, "provider" | "options" | "featureValues">
    >({
      profile,
      stored: held.find((candidate) => candidate.id === profile.id),
      source,
      convert: convertWith,
    });
    const { providerOptions, ...converted } = convertLegacyClaudeUltracode(
      { ...folded, thinkingOptionId: profile.thinkingOptionId, providerOptions: folded.options },
      resolveAdapter({ provider: profile.provider, extendsOf: (id) => providers?.[id]?.extends }),
    );
    return { ...converted, options: providerOptions };
  };
  return {
    ...config,
    agentProfiles: config.agentProfiles.map((profile) => {
      // A malformed value rejects a client write before anything is committed.
      if (source === "client write") return foldWith(profile, convert);
      try {
        return foldWith(profile, convert);
      } catch {
        // A hand-edited `config.json` value that cannot convert must not stop the daemon from
        // starting; it keeps its keys and is rejected when an agent is created from it.
        return foldWith(profile, identity);
      }
    }),
  };
}

/** The config API boundary for reads, patch replies, and change notifications. */
export function toWireDaemonConfig(config: MutableDaemonConfig): MutableDaemonConfig {
  const { providers, agentProfiles, ...wireConfig } = config;
  return {
    ...wireConfig,
    providers: Object.fromEntries(
      // Provider defaults and legacy params are opaque adapter inputs and have no config UI reader.
      Object.entries(providers).map(
        ([
          id,
          { env: _env, options: _options, params: _params, deferDiscovery: _deferred, ...provider },
        ]) => [id, provider],
      ),
    ),
    // Older clients read profile options from `featureValues`.
    ...(agentProfiles && { agentProfiles: agentProfiles.map(withLegacyProfileFeatureValues) }),
  };
}

/** Parser and apply errors may contain parts of the persisted or submitted config. */
export function toWireDaemonConfigError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    if (error.message.startsWith("[Config] Invalid JSON in ")) {
      return new Error("Invalid JSON in daemon config");
    }
    if (error.message.startsWith("[Config] Invalid config in ")) {
      return new Error("Invalid daemon config");
    }
    if (PUBLIC_CONFIG_ERRORS.has(error.message)) return new Error(error.message);
  }
  return new Error(fallback);
}

const RELAY_OVERRIDE_ERROR =
  "Relay is controlled by a daemon launch override. Remove PASEO_RELAY_ENABLED or the relay CLI flag before changing it here.";
const SPEECH_SETTINGS_UNAVAILABLE = "Speech settings are unavailable for this daemon instance";
const CONFIG_RELOAD_UNAVAILABLE = "Daemon config reload is unavailable for this daemon instance";
const CUSTOM_CLI_IDENTITY_CHANGED =
  "Provider identity differs between the file and the running daemon. Reload the daemon config first.";
const CUSTOM_CLI_CONFIG_CHANGED = "Daemon config changed on disk while validating the CLI draft";
const PUBLIC_CONFIG_ERRORS = new Set([
  RELAY_OVERRIDE_ERROR,
  SPEECH_SETTINGS_UNAVAILABLE,
  CONFIG_RELOAD_UNAVAILABLE,
  CUSTOM_CLI_IDENTITY_CHANGED,
  CUSTOM_CLI_CONFIG_CHANGED,
]);

function getValueAtPath(config: MutableDaemonConfig, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, segment) => (isRecord(value) ? value[segment] : undefined), config);
}

function isEqualValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function rebaseProviderFields(
  runtime: Record<string, unknown>,
  previous: Record<string, unknown>,
  persisted: Record<string, unknown>,
): Record<string, unknown> {
  const fields = new Map(Object.entries(runtime));
  for (const key of new Set([...Object.keys(previous), ...Object.keys(persisted)])) {
    const before = Object.hasOwn(previous, key) ? previous[key] : undefined;
    const after = Object.hasOwn(persisted, key) ? persisted[key] : undefined;
    if (isEqualValue(before, after)) continue;
    if (after === undefined) {
      fields.delete(key);
    } else if (isRecord(after) && (isRecord(before) || before === undefined)) {
      const current = fields.get(key);
      fields.set(key, rebaseProviderFields(isRecord(current) ? current : {}, before ?? {}, after));
    } else {
      fields.set(key, after);
    }
  }
  return Object.fromEntries(fields);
}

function readProviderOverrides(
  config: PersistedConfig,
): Record<string, ProviderOverride> | undefined {
  // The persisted loader normalizes legacy runtime settings into provider overrides.
  return config.agents?.providers as Record<string, ProviderOverride> | undefined;
}

function providerLaunchFields(provider: MutableDaemonConfig["providers"][string] | undefined) {
  return {
    command: provider?.["command"],
    env: provider?.["env"] ?? {},
    extends: provider?.["extends"],
  };
}

function prepareCustomProviderCliOverride(
  patch: MutableDaemonConfig["providers"][string],
  runtime: MutableDaemonConfig["providers"][string] | undefined,
  known: ProviderOverride | undefined,
  onDisk: ProviderOverride | undefined,
) {
  if (runtime?.["extends"] !== onDisk?.extends) throw new Error(CUSTOM_CLI_IDENTITY_CHANGED);
  const { deferDiscovery: _deferred, ...submitted } = ProviderOverrideSchema.parse(patch);
  if (Object.keys(submitted).length === 0) return;

  const rebased = rebaseProviderFields(runtime ?? {}, known ?? {}, onDisk ?? {});
  // A display-only edit must not apply unrelated, manually edited launch fields to the runtime.
  const fields = ["command", "env", "extends", "deferDiscovery"] as const;
  if (fields.every((key) => !Object.hasOwn(submitted, key))) {
    for (const key of fields) {
      if (runtime && Object.hasOwn(runtime, key)) rebased[key] = runtime[key];
      else delete rebased[key];
    }
  }
  const nextRuntime = deepMerge(rebased, submitted);
  const nextPersisted = deepMerge(onDisk ?? {}, submitted);
  if (
    !isDeepStrictEqual(providerLaunchFields(runtime), providerLaunchFields(nextRuntime)) ||
    !isDeepStrictEqual(providerLaunchFields(onDisk), providerLaunchFields(nextPersisted))
  ) {
    nextRuntime["deferDiscovery"] = true;
    nextPersisted.deferDiscovery = true;
  }
  return { nextRuntime, nextPersisted };
}

function prepareCustomProviderCliPatch(
  currentProviders: MutableDaemonConfig["providers"],
  knownProviders: Record<string, ProviderOverride> | undefined,
  persistedProviders: Record<string, ProviderOverride> | undefined,
  draftPatch: MutableDaemonConfigPatch,
) {
  const { providers: providerPatches = {} } = MutableDaemonConfigPatchSchema.parse(draftPatch);
  const nextRuntimeProviders = { ...currentProviders };
  const providerUpdates: Record<string, ProviderOverride> = {};
  const checkedProviders = new Set<string>();

  for (const [id, providerPatch] of Object.entries(providerPatches)) {
    const prepared = prepareCustomProviderCliOverride(
      providerPatch,
      currentProviders[id],
      knownProviders?.[id],
      persistedProviders?.[id],
    );
    if (!prepared) continue;
    checkedProviders.add(id);
    const base = prepared.nextPersisted.extends;
    if (base && base !== "acp") checkedProviders.add(base);
    nextRuntimeProviders[id] = prepared.nextRuntime;
    providerUpdates[id] = prepared.nextPersisted;
  }

  return { nextRuntimeProviders, providerUpdates, checkedProviders };
}

const RELOADABLE_PATHS = [
  "daemon.relay.enabled",
  "daemon.relay.requireProtectedSecurity",
  "daemon.mcp.enabled",
  "daemon.mcp.injectIntoAgents",
  "daemon.usage.enabled",
  "daemon.browserTools.enabled",
  "daemon.hostnames",
  "daemon.cors.allowedOrigins",
  "daemon.trustedProxies",
  "daemon.git.maxProcessesPerSecond",
  "daemon.git.maxProcessConcurrency",
  "daemon.autoArchiveAfterMerge",
  "daemon.enableTerminalAgentHooks",
  "daemon.appendSystemPrompt",
  "daemon.mainControlAppendSystemPrompt",
  "daemon.terminalProfiles",
  "daemon.agentProfiles",
  "app.baseUrl",
  "agents.idleRuntimeCleanup",
  "agents.resumeOnStartup",
  "agents.resumePrompt",
  "agents.providers",
  "agents.catalogRefreshTimeoutMs",
  "agents.metadataGeneration",
  "agents.skills.selection",
  "pluginsEnabled",
] as const;

const PERSISTED_TO_MUTABLE_PATH = new Map<string, string>([
  ["daemon.relay.enabled", "relay.enabled"],
  ["daemon.relay.requireProtectedSecurity", "relay.requireProtectedSecurity"],
  ["daemon.mcp.enabled", "mcp.enabled"],
  ["daemon.mcp.injectIntoAgents", "mcp.injectIntoAgents"],
  ["daemon.usage.enabled", "usage.enabled"],
  ["daemon.browserTools.enabled", "browserTools.enabled"],
  ["daemon.hostnames", "hostnames"],
  ["daemon.cors.allowedOrigins", "cors.allowedOrigins"],
  ["daemon.trustedProxies", "trustedProxies"],
  ["daemon.git.maxProcessesPerSecond", "git.maxProcessesPerSecond"],
  ["daemon.git.maxProcessConcurrency", "git.maxProcessConcurrency"],
  ["daemon.autoArchiveAfterMerge", "autoArchiveAfterMerge"],
  ["daemon.enableTerminalAgentHooks", "enableTerminalAgentHooks"],
  ["daemon.appendSystemPrompt", "appendSystemPrompt"],
  ["daemon.mainControlAppendSystemPrompt", "mainControlAppendSystemPrompt"],
  ["daemon.terminalProfiles", "terminalProfiles"],
  ["daemon.agentProfiles", "agentProfiles"],
  ["app.baseUrl", "app.baseUrl"],
  ["agents.idleRuntimeCleanup", "idleRuntimeCleanup"],
  ["agents.resumeOnStartup", "resumeOnStartup"],
  ["agents.resumePrompt", "resumePrompt"],
  ["agents.providers", "providers"],
  ["agents.catalogRefreshTimeoutMs", "catalogRefreshTimeoutMs"],
  ["agents.metadataGeneration", "metadataGeneration"],
  ["agents.skills.selection", "skills.selection"],
  ["pluginsEnabled", "pluginsEnabled"],
]);

function pathBelongsTo(path: string, owner: string): boolean {
  return path === owner || path.startsWith(`${owner}.`);
}

function diffPaths(previous: unknown, next: unknown, prefix = ""): string[] {
  if (isEqualValue(previous, next)) return [];
  if (!isRecord(previous) || !isRecord(next)) {
    if (isRecord(previous)) return leafPaths(previous, prefix);
    if (isRecord(next)) return leafPaths(next, prefix);
    return prefix ? [prefix] : [];
  }

  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return Array.from(keys).flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return diffPaths(previous[key], next[key], path);
  });
}

function leafPaths(record: Record<string, unknown>, prefix: string): string[] {
  return Object.entries(record).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return isRecord(value) ? leafPaths(value, path) : [path];
  });
}

function compactOwnedPaths(paths: readonly string[], owners: readonly string[]): string[] {
  const compacted = new Set<string>();
  for (const path of paths) {
    const owner = owners.find((candidate) => pathBelongsTo(path, candidate));
    compacted.add(owner ?? path);
  }
  return Array.from(compacted).sort();
}

function pickRelayPatch(
  relay: MutableDaemonConfigPatch["relay"],
): Pick<SupportedMutableConfigPatch, "relay"> {
  const picked: NonNullable<SupportedMutableConfigPatch["relay"]> = {
    ...(relay?.enabled !== undefined ? { enabled: relay.enabled } : {}),
    ...(relay?.requireProtectedSecurity !== undefined
      ? { requireProtectedSecurity: relay.requireProtectedSecurity }
      : {}),
  };
  return Object.keys(picked).length > 0 ? { relay: picked } : {};
}

function pickSupportedPatchFields(patch: MutableDaemonConfigPatch): SupportedMutableConfigPatch {
  return {
    ...pickRelayPatch(patch.relay),
    usage: patch.usage,
    ...(patch.mcp?.injectIntoAgents !== undefined
      ? { mcp: { injectIntoAgents: patch.mcp.injectIntoAgents } }
      : {}),
    ...(patch.browserTools?.enabled !== undefined
      ? { browserTools: { enabled: patch.browserTools.enabled } }
      : {}),
    ...(patch.providers !== undefined
      ? {
          providers: Object.fromEntries(
            Object.entries(patch.providers).map(
              ([id, { deferDiscovery: _deferred, ...provider }]) => [id, provider],
            ),
          ),
        }
      : {}),
    ...(patch.removeProviders !== undefined ? { removeProviders: patch.removeProviders } : {}),
    ...(patch.metadataGeneration?.providers !== undefined
      ? { metadataGeneration: { providers: patch.metadataGeneration.providers } }
      : {}),
    ...(patch.autoArchiveAfterMerge !== undefined
      ? { autoArchiveAfterMerge: patch.autoArchiveAfterMerge }
      : {}),
    ...(patch.enableTerminalAgentHooks !== undefined
      ? { enableTerminalAgentHooks: patch.enableTerminalAgentHooks }
      : {}),
    ...(patch.resumeOnStartup !== undefined ? { resumeOnStartup: patch.resumeOnStartup } : {}),
    ...(patch.resumePrompt !== undefined ? { resumePrompt: patch.resumePrompt } : {}),
    ...(patch.idleRuntimeCleanup !== undefined
      ? { idleRuntimeCleanup: patch.idleRuntimeCleanup }
      : {}),
    ...(patch.appendSystemPrompt !== undefined
      ? { appendSystemPrompt: patch.appendSystemPrompt }
      : {}),
    mainControlAppendSystemPrompt: patch.mainControlAppendSystemPrompt,
    ...(patch.terminalProfiles !== undefined ? { terminalProfiles: patch.terminalProfiles } : {}),
    ...(patch.agentProfiles !== undefined ? { agentProfiles: patch.agentProfiles } : {}),
    ...(patch.pluginsEnabled !== undefined ? { pluginsEnabled: patch.pluginsEnabled } : {}),
    ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
    ...(patch.features !== undefined ? { features: patch.features } : {}),
  };
}

export function applyMutableProviderConfigToOverrides(
  baseOverrides: Record<string, ProviderOverride> | undefined,
  mutableProviders: MutableDaemonConfig["providers"] | undefined,
): Record<string, ProviderOverride> | undefined {
  if (!baseOverrides && (!mutableProviders || Object.keys(mutableProviders).length === 0)) {
    return undefined;
  }

  const nextOverrides: Record<string, ProviderOverride> = { ...baseOverrides };
  for (const [providerId, providerConfig] of Object.entries(mutableProviders ?? {})) {
    const previousOverride = nextOverrides[providerId];
    const parsedOverride = ProviderOverrideSchema.strip().parse(providerConfig);
    nextOverrides[providerId] = {
      ...previousOverride,
      ...parsedOverride,
      ...(parsedOverride.paseoTools
        ? {
            paseoTools: {
              ...previousOverride?.paseoTools,
              ...parsedOverride.paseoTools,
            },
          }
        : {}),
    };
  }

  return nextOverrides;
}

export class DaemonConfigStore {
  private mutations: Promise<unknown> = Promise.resolve();
  private current: MutableDaemonConfig;
  private readonly paseoHome: string;
  private readonly logger: LoggerLike | undefined;
  private readonly changeListeners = new Set<ConfigListener>();
  private readonly applyListeners = new Set<ConfigApplyListener>();
  private readonly fieldChangeHandlers = new Map<string, Set<FieldChangeHandler>>();
  private readonly relayEnabledMutable: boolean;
  private readonly reloadSource: DaemonConfigReloadSource | undefined;
  private readonly startupPersisted: PersistedConfig;
  private readonly speechOwner: SpeechSettingsOwner | undefined;
  private lastKnownPersisted: PersistedConfig;
  private restartRecoveryCleanup?: () => Promise<void>;
  private restartRecoveryCleanupPending = false;

  constructor(
    paseoHome: string,
    initial: MutableDaemonConfig,
    logger?: LoggerLike,
    options: {
      relayEnabledMutable?: boolean;
      reloadSource?: DaemonConfigReloadSource;
      startupPersisted?: PersistedConfig;
      speech?: SpeechSettingsOwner;
    } = {},
  ) {
    this.paseoHome = paseoHome;
    this.logger = getLogger(logger);
    this.relayEnabledMutable = options.relayEnabledMutable ?? true;
    this.reloadSource = options.reloadSource;
    this.speechOwner = options.speech;
    this.startupPersisted = options.startupPersisted ?? loadPersistedConfig(paseoHome, this.logger);
    this.lastKnownPersisted = this.startupPersisted;
    this.current = MutableDaemonConfigSchema.parse({
      ...foldConfigProfiles({ config: initial, providers: initial.providers, source: "stored" }),
      relay: initial.relay ?? { enabled: true },
      ...this.readSpeech(this.startupPersisted),
    });
  }

  public get(): MutableDaemonConfig {
    return this.current;
  }

  public setRestartRecoveryCleanup(cleanup: () => Promise<void>): void {
    this.restartRecoveryCleanup = cleanup;
  }

  public patch(
    partial:
      | MutableDaemonConfigPatch
      | ((current: MutableDaemonConfig) => MutableDaemonConfigPatch),
  ): Promise<MutableDaemonConfig> {
    return this.enqueue(async () => {
      const patch = pickSupportedPatchFields(
        MutableDaemonConfigPatchSchema.parse(
          typeof partial === "function" ? partial(this.current) : partial,
        ),
      );
      if (patch.resumeOnStartup !== undefined) await this.finishRestartRecoveryCleanup();
      return this.applySupportedPatch(patch);
    });
  }

  public patchCustomProviderCli(
    prepare: (
      current: MutableDaemonConfig,
      persistedProviders: Record<string, ProviderOverride> | undefined,
    ) => Promise<MutableDaemonConfigPatch>,
  ): Promise<MutableDaemonConfig> {
    return this.enqueue(async () => {
      const sanitize = (error: unknown): never => {
        throw toWireDaemonConfigError(error, "Failed to save custom provider CLI");
      };
      const persisted = await loadPersistedConfigAsync(this.paseoHome, this.logger).catch(sanitize);
      const draftPatch = await prepare(this.current, readProviderOverrides(persisted));
      return this.commitCustomProviderCli(persisted, draftPatch).catch(sanitize);
    });
  }

  private async commitCustomProviderCli(
    persisted: PersistedConfig,
    draftPatch: MutableDaemonConfigPatch,
  ): Promise<MutableDaemonConfig> {
    const persistedProviders = readProviderOverrides(persisted);
    const knownProviders = readProviderOverrides(this.lastKnownPersisted);
    const { nextRuntimeProviders, providerUpdates, checkedProviders } =
      prepareCustomProviderCliPatch(
        this.current.providers,
        knownProviders,
        persistedProviders,
        draftPatch,
      );
    const written = Object.keys(providerUpdates);
    if (written.length === 0) return this.current;

    const next = MutableDaemonConfigSchema.parse({
      ...this.current,
      providers: nextRuntimeProviders,
    });
    const withProviders = (
      base: PersistedConfig,
      providers: Record<string, ProviderOverride>,
    ): PersistedConfig => ({ ...base, agents: { ...base.agents, providers } }) as PersistedConfig;

    // Only the submitted providers and their launch bases were validated. Keep other file edits.
    const latest = await this.readCheckedCustomCliConfig(persistedProviders, checkedProviders);
    await savePersistedConfigAsync(
      this.paseoHome,
      withProviders(latest, { ...readProviderOverrides(latest), ...providerUpdates }),
      this.logger,
    );
    try {
      this.applyReplacement(next, { removedProviders: [] });
    } catch (error) {
      await savePersistedConfigAsync(this.paseoHome, latest, this.logger);
      throw error;
    }
    this.lastKnownPersisted = withProviders(this.lastKnownPersisted, {
      ...knownProviders,
      ...providerUpdates,
    });
    return this.current;
  }

  private async readCheckedCustomCliConfig(
    validatedProviders: Record<string, ProviderOverride> | undefined,
    checkedProviders: ReadonlySet<string>,
  ): Promise<PersistedConfig> {
    const latest = await loadPersistedConfigAsync(this.paseoHome, this.logger);
    const latestProviders = readProviderOverrides(latest);
    for (const id of checkedProviders) {
      if (!isDeepStrictEqual(latestProviders?.[id], validatedProviders?.[id])) {
        throw new Error(CUSTOM_CLI_CONFIG_CHANGED);
      }
    }
    return latest;
  }

  public setAgentSkillSelection(selection: AgentSkillSelection): Promise<MutableDaemonConfig> {
    return this.enqueue(() => this.applySupportedPatch({ skills: { selection } }));
  }

  private foldPatchProfiles<
    T extends { agentProfiles?: AgentProfile[]; providers?: Record<string, ProviderOverride> },
  >(submittedPatch: T): T {
    return foldConfigProfiles({
      config: submittedPatch,
      // The provider graph this request will commit, so `extends` survives a partial edit.
      providers: deepMerge(this.current.providers ?? {}, submittedPatch.providers ?? {}),
      source: "client write",
      held: this.current.agentProfiles,
    });
  }

  private async applySupportedPatch(
    parsedPatch: SupportedMutableConfigPatch,
  ): Promise<MutableDaemonConfig> {
    if (parsedPatch.relay?.enabled !== undefined && !this.relayEnabledMutable) {
      throw new Error(RELAY_OVERRIDE_ERROR);
    }
    const { removeProviders = [], ...submittedPatch } = parsedPatch;
    const patch = this.foldPatchProfiles(submittedPatch);
    const { features: speechPatch, ...configPatch } = patch;
    const removedProviders = Array.from(new Set(removeProviders));
    const merged = deepMerge(this.current, configPatch);
    if (speechPatch !== undefined) Object.assign(merged, this.readPatchedSpeech(speechPatch));
    if (parsedPatch.skills?.selection !== undefined) {
      merged.skills = { selection: parsedPatch.skills.selection };
    }
    if (parsedPatch.plugins !== undefined) merged.plugins = parsedPatch.plugins;
    const next = MutableDaemonConfigSchema.parse(
      omitMetadataGenerationProvidersFromConfig(
        omitProvidersFromConfig(merged, removedProviders),
        removedProviders,
      ),
    );

    const configChanged = !isEqualValue(this.current, next);
    const disablingRecovery =
      this.current.resumeOnStartup === true && next.resumeOnStartup !== true;

    // A replaced API key leaves the speech view unchanged, so a speech patch always persists.
    if (
      !configChanged &&
      removedProviders.length === 0 &&
      speechPatch === undefined &&
      !this.needsDiskUpdate(patch)
    ) {
      return this.current;
    }

    const { previous: persistedBeforePatch, knownNext } = await this.persistConfig(
      patch,
      removedProviders,
    );
    const speechChanged = this.speechPersistedChanged(this.lastKnownPersisted, knownNext);
    if (configChanged) {
      try {
        this.applyReplacement(next, { removedProviders });
      } catch (error) {
        await savePersistedConfigAsync(this.paseoHome, persistedBeforePatch, this.logger);
        throw error;
      }
    }
    this.lastKnownPersisted = knownNext;
    await this.finishRestartRecoveryChange(disablingRecovery);
    if (speechChanged) this.speechOwner?.apply(knownNext);

    return this.current;
  }

  private needsDiskUpdate(patch: SupportedMutableConfigPatch): boolean {
    const daemon = this.lastKnownPersisted.daemon;
    // Profiles held folded in memory may still use `featureValues` on disk.
    if (
      patch.agentProfiles !== undefined &&
      !isEqualValue(patch.agentProfiles, daemon?.agentProfiles)
    ) {
      return true;
    }
    // An explicit empty prompt must be saved even when it equals the runtime default.
    return (
      patch.mainControlAppendSystemPrompt !== undefined &&
      patch.mainControlAppendSystemPrompt !== daemon?.mainControlAppendSystemPrompt
    );
  }

  private readSpeech(
    persisted: PersistedConfig,
  ): Pick<MutableDaemonConfig, "features" | "envOverrides"> {
    return this.speechOwner ? this.speechOwner.read(persisted) : {};
  }

  private readPatchedSpeech(
    speechPatch: SpeechSettingsPatch,
  ): Pick<MutableDaemonConfig, "features" | "envOverrides"> {
    if (!this.speechOwner) {
      throw new Error(SPEECH_SETTINGS_UNAVAILABLE);
    }
    return this.speechOwner.read(mergeSpeechSettingsPatch(this.lastKnownPersisted, speechPatch));
  }

  private speechPersistedChanged(previous: PersistedConfig, next: PersistedConfig): boolean {
    return diffPaths(previous, next).some((path) =>
      SPEECH_PERSISTED_PATHS.some((owner) => pathBelongsTo(path, owner)),
    );
  }

  public reload(): Promise<DaemonConfigReloadResult> {
    return this.enqueue(() => this.reloadPersisted());
  }

  private async reloadPersisted(): Promise<DaemonConfigReloadResult> {
    if (!this.reloadSource) {
      throw new Error(CONFIG_RELOAD_UNAVAILABLE);
    }

    const persisted = await loadPersistedConfigAsync(this.paseoHome, this.logger);
    const resolved = this.reloadSource.resolve(persisted);
    // Plugin source changes require the plugin lifecycle operation or a daemon
    // restart. The global switch is independently reloadable.
    const desired = MutableDaemonConfigSchema.parse({
      ...foldConfigProfiles({
        config: resolved.mutable,
        providers: resolved.mutable.providers,
        source: "stored",
      }),
      plugins: this.current.plugins,
      ...this.readSpeech(persisted),
    });
    const changedSinceLastApply = diffPaths(this.lastKnownPersisted, persisted);
    const overrideControlledPaths = compactOwnedPaths(
      changedSinceLastApply.filter((path) =>
        resolved.overrideControlledPaths.some((owner) => pathBelongsTo(path, owner)),
      ),
      resolved.overrideControlledPaths,
    );
    const appliedPaths: string[] = RELOADABLE_PATHS.filter((persistedPath) => {
      if (resolved.overrideControlledPaths.some((owner) => pathBelongsTo(persistedPath, owner))) {
        return false;
      }
      const mutablePath = PERSISTED_TO_MUTABLE_PATH.get(persistedPath);
      return (
        mutablePath !== undefined &&
        !isEqualValue(
          getValueAtPath(this.current, mutablePath),
          getValueAtPath(desired, mutablePath),
        )
      );
    });
    const restartRequiredPaths = compactOwnedPaths(
      diffPaths(this.startupPersisted, persisted).filter((path) => {
        if (path === "$schema" || path === "version") return false;
        if (RELOADABLE_PATHS.some((owner) => pathBelongsTo(path, owner))) return false;
        if (this.speechOwner && SPEECH_PERSISTED_PATHS.some((owner) => pathBelongsTo(path, owner)))
          return false;
        return !resolved.overrideControlledPaths.some((owner) => pathBelongsTo(path, owner));
      }),
      [],
    );

    const removedProviders = Object.keys(this.current.providers).filter(
      (provider) => !(provider in desired.providers),
    );
    const speechChanged = this.speechPersistedChanged(this.lastKnownPersisted, persisted);
    const disablingRecovery =
      this.current.resumeOnStartup === true && desired.resumeOnStartup !== true;
    await this.finishRestartRecoveryCleanup();
    this.applyReplacement(desired, { removedProviders });
    this.lastKnownPersisted = persisted;
    await this.finishRestartRecoveryChange(disablingRecovery);
    if (speechChanged && this.speechOwner) {
      this.speechOwner.apply(persisted);
      appliedPaths.push(
        ...SPEECH_PERSISTED_PATHS.filter((owner) =>
          changedSinceLastApply.some((path) => pathBelongsTo(path, owner)),
        ),
      );
    }

    return {
      appliedPaths: [...appliedPaths].sort(),
      restartRequiredPaths,
      overrideControlledPaths,
    };
  }

  private async finishRestartRecoveryChange(disablingRecovery: boolean): Promise<void> {
    if (!disablingRecovery || !this.restartRecoveryCleanup) return;
    this.restartRecoveryCleanupPending = true;
    await this.finishRestartRecoveryCleanup();
  }

  private async finishRestartRecoveryCleanup(): Promise<void> {
    if (!this.restartRecoveryCleanupPending) return;
    // Re-enabling must wait for a prior disable to durably consume its intent.
    await this.restartRecoveryCleanup?.();
    this.restartRecoveryCleanupPending = false;
  }

  private applyReplacement(
    next: MutableDaemonConfig,
    changeDetails: DaemonConfigChangeDetails,
  ): void {
    const changedFieldPaths = Array.from(this.fieldChangeHandlers.keys()).filter((path) => {
      return !isEqualValue(getValueAtPath(this.current, path), getValueAtPath(next, path));
    });
    if (isEqualValue(this.current, next) && changeDetails.removedProviders.length === 0) return;

    const previous = this.current;
    const appliedFieldChanges: AppliedFieldChange[] = [];
    const applyRollbacks: ConfigApplyRollback[] = [];
    this.current = next;
    try {
      for (const path of changedFieldPaths) {
        const handlers = this.fieldChangeHandlers.get(path);
        if (!handlers) {
          continue;
        }
        const value = getValueAtPath(next, path);
        const previousValue = getValueAtPath(previous, path);
        for (const handler of handlers) {
          appliedFieldChanges.push({ handler, previousValue });
          handler(value);
        }
      }
      for (const listener of this.applyListeners) {
        applyRollbacks.push(listener(next, previous, changeDetails));
      }
    } catch (error) {
      this.current = previous;
      const rollbackErrors: unknown[] = [];
      for (const rollback of applyRollbacks.toReversed()) {
        try {
          rollback();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const change of appliedFieldChanges.toReversed()) {
        try {
          change.handler(change.previousValue);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        const rollbackFailure = new Error(
          "Daemon config apply failed and one or more live owners could not roll back",
          { cause: error },
        );
        Object.assign(rollbackFailure, { rollbackErrors });
        throw rollbackFailure;
      }
      throw error;
    }

    for (const listener of this.changeListeners) {
      try {
        listener(next, changeDetails);
      } catch {
        this.logger?.info("Daemon config change notification failed");
      }
    }
  }

  public onFieldChange(path: string, handler: FieldChangeHandler): () => void {
    const handlers = this.fieldChangeHandlers.get(path) ?? new Set<FieldChangeHandler>();
    handlers.add(handler);
    this.fieldChangeHandlers.set(path, handlers);

    return () => {
      const currentHandlers = this.fieldChangeHandlers.get(path);
      if (!currentHandlers) {
        return;
      }
      currentHandlers.delete(handler);
      if (currentHandlers.size === 0) {
        this.fieldChangeHandlers.delete(path);
      }
    };
  }

  public onChange(listener: ConfigListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  public onApply(listener: ConfigApplyListener): () => void {
    // A live owner must either throw before changing its state or return a
    // rollback that restores the previous config. Notifications belong in
    // onChange so they run only after every live owner commits.
    this.applyListeners.add(listener);
    return () => {
      this.applyListeners.delete(listener);
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => {});
    return result;
  }

  public readServicePorts(): Promise<NonNullable<PersistedConfig["worktrees"]>["servicePorts"]> {
    return this.enqueue(
      async () =>
        (await loadPersistedConfigAsync(this.paseoHome, this.logger)).worktrees?.servicePorts,
    );
  }

  private async persistConfig(
    patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
    removeProviders: readonly string[],
  ): Promise<{ previous: PersistedConfig; knownNext: PersistedConfig }> {
    const persisted = await loadPersistedConfigAsync(this.paseoHome, this.logger);
    const merge = (source: PersistedConfig) =>
      mergeMutablePatchIntoPersistedConfig({
        persisted: source,
        patch,
        removeProviders,
        persistRelayEnabled: this.relayEnabledMutable,
      });
    const nextPersisted = merge(persisted);
    const knownNext = merge(this.lastKnownPersisted);
    await savePersistedConfigAsync(this.paseoHome, nextPersisted, this.logger);
    return { previous: persisted, knownNext };
  }
}

function mergeMutablePatchIntoPersistedConfig(params: {
  persisted: PersistedConfig;
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">;
  removeProviders: readonly string[];
  persistRelayEnabled: boolean;
}): PersistedConfig {
  const { persisted, patch, removeProviders, persistRelayEnabled } = params;
  const daemon = mergeMutableDaemonPatch(persisted.daemon, patch, persistRelayEnabled);
  const agents = mergeMutableAgentPatch(persisted.agents, patch, removeProviders);
  const withSpeech = patch.features
    ? mergeSpeechSettingsPatch(persisted, patch.features)
    : persisted;
  return {
    ...withSpeech,
    ...(patch.pluginsEnabled !== undefined ? { pluginsEnabled: patch.pluginsEnabled } : {}),
    ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
    ...(daemon ? { daemon } : { daemon: undefined }),
    ...(agents ? { agents } : { agents: undefined }),
  } as PersistedConfig;
}

function mergeMutableAgentPatch(
  persistedAgents: PersistedConfig["agents"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
  removeProviders: readonly string[],
): PersistedConfig["agents"] {
  if (
    patch.providers === undefined &&
    patch.metadataGeneration === undefined &&
    patch.skills === undefined &&
    !hasRestartRecoveryPatch(patch) &&
    patch.idleRuntimeCleanup === undefined &&
    removeProviders.length === 0
  ) {
    return persistedAgents;
  }

  const next = { ...persistedAgents } as Record<string, unknown>;
  const persistedProviderOverrides = omitProvidersFromOverrides(
    persistedAgents?.providers as Record<string, ProviderOverride> | undefined,
    removeProviders,
  );
  const providerOverrides = applyMutableProviderConfigToOverrides(
    persistedProviderOverrides,
    patch.providers,
  );
  if (providerOverrides) next["providers"] = providerOverrides;
  else delete next["providers"];

  if (patch.metadataGeneration?.providers !== undefined) {
    next["metadataGeneration"] = { providers: patch.metadataGeneration.providers };
  } else if (removeProviders.length > 0 && persistedAgents?.metadataGeneration?.providers) {
    const removed = new Set(removeProviders);
    next["metadataGeneration"] = {
      providers: persistedAgents.metadataGeneration.providers.filter(
        (entry) => !removed.has(entry.provider),
      ),
    };
  }

  if (patch.skills?.selection !== undefined) {
    next["skills"] = { selection: patch.skills.selection };
  }

  Object.assign(next, restartRecoveryPatch(patch));
  if (patch.idleRuntimeCleanup !== undefined) {
    next["idleRuntimeCleanup"] = patch.idleRuntimeCleanup;
  }

  return Object.keys(next).length > 0 ? (next as PersistedConfig["agents"]) : undefined;
}

function mergeMutableDaemonPatch(
  persistedDaemon: PersistedConfig["daemon"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
  persistRelayEnabled: boolean,
): PersistedConfig["daemon"] {
  const next = { ...persistedDaemon } as NonNullable<PersistedConfig["daemon"]>;
  if (persistRelayEnabled && patch.relay?.enabled !== undefined) {
    next.relay = { ...next.relay, enabled: patch.relay.enabled };
  }
  if (patch.relay?.requireProtectedSecurity !== undefined) {
    next.relay = { ...next.relay, requireProtectedSecurity: patch.relay.requireProtectedSecurity };
  }
  if (patch.mcp?.injectIntoAgents !== undefined) {
    next.mcp = { ...next.mcp, injectIntoAgents: patch.mcp.injectIntoAgents };
  }
  if (patch.usage) next.usage = patch.usage;
  if (patch.browserTools?.enabled !== undefined) {
    next.browserTools = { ...next.browserTools, enabled: patch.browserTools.enabled };
  }
  if (patch.autoArchiveAfterMerge !== undefined) {
    next.autoArchiveAfterMerge = patch.autoArchiveAfterMerge;
  }
  if (patch.enableTerminalAgentHooks !== undefined) {
    next.enableTerminalAgentHooks = patch.enableTerminalAgentHooks;
  }
  if (patch.appendSystemPrompt !== undefined) next.appendSystemPrompt = patch.appendSystemPrompt;
  if (patch.mainControlAppendSystemPrompt !== undefined) {
    next.mainControlAppendSystemPrompt = patch.mainControlAppendSystemPrompt;
  }
  if (patch.terminalProfiles !== undefined) next.terminalProfiles = patch.terminalProfiles;
  if (patch.agentProfiles !== undefined) next.agentProfiles = patch.agentProfiles;
  return Object.keys(next).length > 0 ? next : undefined;
}

function hasRestartRecoveryPatch(patch: SupportedMutableConfigPatch) {
  return patch.resumeOnStartup !== undefined || patch.resumePrompt !== undefined;
}
function restartRecoveryPatch(patch: SupportedMutableConfigPatch) {
  return {
    ...(patch.resumeOnStartup !== undefined ? { resumeOnStartup: patch.resumeOnStartup } : {}),
    ...(patch.resumePrompt !== undefined ? { resumePrompt: patch.resumePrompt } : {}),
  };
}
