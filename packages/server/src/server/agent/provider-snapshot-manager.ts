import { normalizeAgentModelCatalog, type ProviderOptions } from "@getpaseo/protocol/agent-types";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Logger } from "pino";
import pLimit, { type LimitFunction } from "p-limit";

import { expandTilde } from "../../utils/path.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import {
  filterSelectableAgentModels,
  type AgentClient,
  type AgentCreateConfigParent,
  type AgentMode,
  type AgentModelDefinition,
  type AgentProvider,
  type FetchCatalogOptions,
  type ProviderSnapshotEntry,
} from "./agent-sdk-types.js";
import {
  raceProviderRefreshAbort,
  runProviderRefreshWithDeadline,
} from "./provider-refresh-deadline.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import type { OpenCodeBridge } from "./providers/opencode/bridge.js";
import {
  createProviderEnv,
  type AgentProviderRuntimeSettingsMap,
  type ProviderOverride,
} from "./provider-launch-config.js";
import {
  buildProviderRegistry,
  shutdownAgentClients,
  type ProviderDefinition,
} from "./provider-registry.js";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { applyMutableProviderConfigToOverrides } from "../daemon-config-store.js";
import {
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
} from "./providers/diagnostic-utils.js";
import type { MutableDaemonConfig } from "../daemon-config-store.js";
import type { HubExecutionAgentValidationIssue } from "@getpaseo/protocol/messages";
import {
  type AgentConfigurationValidationInput,
  validateAgentConfigurationAgainstProvider,
} from "./agent-configuration-validator.js";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { PluginAgentClientRegistry } from "./plugin-provider.js";
import { convertLegacyClaudeUltracode, resolveAdapter } from "./option-controls.js";
import { installationActivity } from "./provider-installation/installation-activity.js";
import {
  ProviderInstallations,
  discoveredReleaseCheck,
  type DiscoveredReleaseCheck,
} from "./provider-installation/provider-installations.js";
import {
  hasDynamicProviderLauncherName,
  isDynamicProviderLauncher,
} from "./custom-provider-cli.js";
import {
  ProviderRefreshSchedule,
  systemProviderRefreshTimers,
  type ProviderRefreshTimers,
} from "./provider-refresh-schedule.js";

const DEFAULT_REFRESH_TIMEOUT_MS = 120_000;
const MAX_REFRESH_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 120_000;
const USAGE_PROVIDER_ACTIVITY_TIMEOUT_MS = 5_000;
const USAGE_PROVIDER_ACTIVITY_TTL_MS = 300_000;
const PROVIDER_REFRESH_DEADLINE_ENV = "PASEO_PROVIDER_REFRESH_TIMEOUT_MS";
const CUSTOM_CLI_DISCOVERY_FAILED = "Custom CLI discovery failed";
/** How long shutdown waits for aborted probes; a provider ignoring the abort must not hang it. */
const PROBE_SHUTDOWN_GRACE_MS = 10_000;
export const GLOBAL_PROVIDER_SNAPSHOT_KEY = "paseo:global";

function validRefreshDeadline(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_REFRESH_TIMEOUT_MS
    ? value
    : undefined;
}

function providerRefreshDeadline(configured: number | undefined): number {
  const explicit = validRefreshDeadline(configured);
  if (explicit !== undefined) return explicit;
  return (
    validRefreshDeadline(Number(process.env[PROVIDER_REFRESH_DEADLINE_ENV])) ??
    DEFAULT_REFRESH_TIMEOUT_MS
  );
}

function resolveDiagnosticTimeoutMs(option: number | undefined, refreshTimeoutMs: number): number {
  if (typeof option === "number" && Number.isFinite(option) && option > 0) {
    return option;
  }
  return Math.max(refreshTimeoutMs, DEFAULT_DIAGNOSTIC_TIMEOUT_MS);
}

function omitProviderOverrides(
  overrides: Record<string, ProviderOverride> | undefined,
  providers: readonly string[],
): Record<string, ProviderOverride> | undefined {
  if (!overrides || providers.length === 0) return overrides;
  const nextOverrides = { ...overrides };
  for (const provider of providers) delete nextOverrides[provider];
  return Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined;
}

/** Published values are shared read-only; provider-owned data is detached at publication. */
export interface ProviderSnapshotRecord {
  readonly entry: ProviderSnapshotEntry;
  readonly contentHash: string;
}

export interface ProviderSnapshot {
  readonly cwd: string;
  readonly records: readonly ProviderSnapshotRecord[];
}

export interface ProviderSnapshotTransition {
  readonly previous: ProviderSnapshot;
  readonly current: ProviderSnapshot;
}

type ProviderSnapshotChangeListener = (transition: ProviderSnapshotTransition) => void;

export interface ProviderSnapshotManagerOptions {
  logger: Logger;
  paseoHome?: string;
  runtimeSettings?: AgentProviderRuntimeSettingsMap;
  providerOverrides?: Record<string, ProviderOverride>;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  managedProcesses?: ManagedProcessRegistry;
  isDev?: boolean;
  extraClients?: Partial<Record<AgentProvider, AgentClient>>;
  refreshTimeoutMs?: number;
  diagnosticTimeoutMs?: number;
  openCodeBridge?: OpenCodeBridge;
  /** Refreshes enabled providers in the background; omitted, catalogues refresh only on request. */
  backgroundRefresh?: ProviderBackgroundRefreshOptions;
}

export interface ProviderBackgroundRefreshOptions {
  intervalMs: number;
  timers?: ProviderRefreshTimers;
}

/**
 * Why a catalogue is probed although it may hold a result. A background refresh joins discovery
 * in flight and publishes only a changed catalogue; a failure keeps a ready one.
 */
type RefreshReason = "manual" | "background";

interface ProviderSnapshotRefreshOptions {
  cwd: string;
  providers?: AgentProvider[];
}

interface ProviderSnapshotWarmUpOptions {
  cwd?: string | null;
  providers?: AgentProvider[];
}

interface ProviderSnapshotReadOptions {
  cwd?: string | null;
  providers?: AgentProvider[];
  wait?: boolean;
}

interface ApplyMutableProviderConfigOptions {
  removeProviders?: readonly string[];
  replace?: boolean;
}

export interface PreparedMutableProviderConfig {
  agentManagerState: AgentManagerProviderState;
  commit(): void;
}

interface ProviderSnapshotProviderOptions {
  cwd?: string | null;
  provider: AgentProvider;
  wait?: boolean;
}

export interface ResolveProviderCreateConfigOptions {
  cwd?: string | null;
  provider: AgentProvider;
  requestedMode: string | undefined;
  providerOptions: ProviderOptions | undefined;
  parent: ManagedAgent | null;
  unattended: boolean;
}

export interface ResolvedProviderCreateConfig {
  modeId: string | undefined;
  providerOptions: ProviderOptions | undefined;
}

interface ResolveDefaultModelOptions {
  provider: AgentProvider;
  requestedModel?: string | null;
  cwd?: string;
}

export interface ProviderDiagnosticResult {
  provider: AgentProvider;
  diagnostic: string;
}

export interface AgentManagerProviderState {
  providerDefinitions: Partial<
    Record<
      AgentProvider,
      Pick<ProviderDefinition, "enabled" | "derivedFromProviderId" | "applyToolPolicy"> & {
        isDiscoveryDeferred: (provider: AgentProvider) => boolean;
      }
    >
  >;
  clients: Partial<Record<AgentProvider, AgentClient>>;
  retiredProviders?: readonly AgentProvider[];
}

/** A manual refresh forces the provider and publishes failures; a background one never weakens it. */
function strongerRefresh(
  first: RefreshReason | undefined,
  second: RefreshReason | undefined,
): RefreshReason | undefined {
  return first === "manual" || second === "manual" ? "manual" : (first ?? second);
}

interface ProviderLoadOptions {
  snapshotCwd: string;
  providers: AgentProvider[];
  catalogScope: ProviderCatalogScope;
  refresh?: RefreshReason;
  allowDeferred?: boolean;
  runDiscovery?: ProviderDiscoveryScope;
}

export type ProviderDiscoveryScope = <T>(operation: () => Promise<T>) => Promise<T>;
type DeferredDiscoveryIntent =
  | { kind: "create" }
  | {
      kind: "refresh";
      prepare: (cwd: string) => Promise<ProviderDiscoveryScope | undefined>;
    };
interface CatalogBinding {
  key?: string;
  failure?: ProviderSnapshotRecord;
  /** Refresh intent survives reads that supersede an unfinished key lookup. */
  refresh?: RefreshReason;
  promise: Promise<void>;
}

interface ProviderCatalog {
  result?: ProviderSnapshotRecord;
  installedVersion?: string;
  releaseCheck?: DiscoveredReleaseCheck;
  stale?: RefreshReason;
  load?: Promise<void>;
}

interface RegistryGeneration {
  definitions: Record<AgentProvider, ProviderDefinition>;
  order: readonly AgentProvider[];
  providerStates: ReadonlyMap<AgentProvider, RegistryProviderState>;
}

interface RegistryProviderState {
  initial: ProviderSnapshotRecord;
  discoveryLimit: LimitFunction;
  requiresDiscovery: boolean;
  dynamicLauncher: boolean;
  checkLegacyLauncher?: () => Promise<boolean>;
  discoveryLoads: Map<string, Promise<void>>;
}

function runtimeConfiguration(definition: ProviderDefinition) {
  if (!definition.configuration) return null;
  const {
    definition: { label: _label, description: _description, ...descriptor },
    ...configuration
  } = definition.configuration;
  return { ...configuration, definition: descriptor };
}

function sameInstallationConfiguration(
  before: ProviderDefinition | undefined,
  after: ProviderDefinition | undefined,
): boolean {
  if (before === after) return true;
  // Plugin definitions have no declarative configuration. Replacing a registration changes
  // the callback that owns installation and maintenance.
  if (!before?.configuration || !after?.configuration) return false;
  return isDeepStrictEqual(runtimeConfiguration(before), runtimeConfiguration(after));
}

function withProviderDisplay(
  record: ProviderSnapshotRecord,
  initial: ProviderSnapshotRecord,
): ProviderSnapshotRecord {
  const { label, description } = initial.entry;
  if (record.entry.label === label && record.entry.description === description) return record;
  return identifyEntry({ ...record.entry, label, description });
}

function safeDiscoveredVersion(version: unknown): string | undefined {
  return typeof version === "string" &&
    /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?:alpha|beta|rc)\.\d{1,6})?$/u.test(version)
    ? version
    : undefined;
}

function providerRequiresDiscovery(
  overrides: Record<string, ProviderOverride> | undefined,
  provider: AgentProvider,
  base: AgentProvider | null,
): boolean {
  return (
    overrides?.[provider]?.deferDiscovery === true ||
    (base !== null && overrides?.[base]?.deferDiscovery === true)
  );
}

function providerNamesDynamicLauncher(definition: ProviderDefinition): boolean {
  const command = definition.configuration?.runtimeSettings?.command;
  return command?.mode === "replace" && hasDynamicProviderLauncherName(command.argv);
}

function initialProviderRecord(
  provider: AgentProvider,
  definition: ProviderDefinition,
  deferred: boolean,
  custom: boolean,
  dynamicLauncher: boolean,
): ProviderSnapshotRecord {
  const staticCatalog = definition.enabled && !deferred && dynamicLauncher;
  const config = definition.configuration;
  return identifyEntry({
    provider,
    status: providerInitialStatus(definition.enabled, deferred, staticCatalog),
    enabled: definition.enabled,
    source: custom ? "custom" : "builtin",
    ...(definition.derivedFromProviderId
      ? { derivedFromProviderId: definition.derivedFromProviderId }
      : {}),
    label: definition.label,
    description: definition.description,
    iconSvg: definition.iconSvg,
    docsUrl: definition.docsUrl,
    defaultModeId: definition.defaultModeId ?? null,
    ...(staticCatalog
      ? {
          models: normalizeAgentModelCatalog(
            [...(config?.profileModels ?? []), ...(config?.additionalModels ?? [])].map((model) =>
              Object.assign({ provider }, model),
            ),
          ),
          modes: definition.modes,
        }
      : {}),
  });
}

function providerInitialStatus(enabled: boolean, deferred: boolean, staticCatalog: boolean) {
  if (!enabled || deferred) return "unavailable";
  return staticCatalog ? "ready" : "loading";
}

interface Target {
  bindings: Map<AgentProvider, CatalogBinding>;
  snapshot: ProviderSnapshot;
}

type ProviderCatalogScope = { scope: "global" } | { scope: "workspace"; cwd: string };

interface ProviderSnapshotTarget {
  snapshotCwd: string;
  catalogScope: ProviderCatalogScope;
}

export class ProviderSnapshotManager {
  private readonly readDiscoveryDeferral = (provider: AgentProvider) =>
    !this.canLaunchProviderForRead(provider);
  private readonly catalogs = new Map<string, Map<AgentProvider, ProviderCatalog>>();
  private readonly targets = new Map<string, Target>();
  private readonly usageActivityCache = new Map<AgentProvider, { at: number; active: boolean }>();
  private readonly events = new EventEmitter();
  private destroyed = false;
  /** Aborts provider work in flight when the manager stops. */
  private readonly stopped = new AbortController();
  private readonly runningProbes = new Set<Promise<void>>();
  private refreshTimeoutMs: number;
  private diagnosticTimeoutMs: number;
  private readonly logger: Logger;
  private readonly workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  private readonly managedProcesses?: ManagedProcessRegistry;
  private readonly openCodeBridge?: OpenCodeBridge;
  private readonly isDev: boolean;
  private readonly extraClients: Partial<Record<AgentProvider, AgentClient>>;
  private runtimeSettings: AgentProviderRuntimeSettingsMap | undefined;
  private providerOverrides: Record<string, ProviderOverride> | undefined;
  private baseProviderOverrides: Record<string, ProviderOverride> | undefined;
  private generation: RegistryGeneration;
  private providerClients: Record<AgentProvider, AgentClient>;
  private readonly ownedClients = new Set<AgentClient>();
  private readonly pluginProviders: PluginAgentClientRegistry;
  /** Installation links and versions; separate from availability and discovery. */
  readonly installations: ProviderInstallations;
  private readonly installationConfigVersions = new Map<AgentProvider, number>();
  private pluginProvidersSettled = false;
  private readonly refreshSchedule: ProviderRefreshSchedule | null;

  constructor(options: ProviderSnapshotManagerOptions) {
    this.logger = options.logger;
    this.pluginProviders = new PluginAgentClientRegistry(
      options.logger.child({ module: "plugin-providers" }),
    );
    this.workspaceGitService = options.workspaceGitService;
    this.managedProcesses = options.managedProcesses;
    this.openCodeBridge = options.openCodeBridge;
    this.isDev = options.isDev === true;
    this.extraClients = options.extraClients ?? {};
    this.runtimeSettings = options.runtimeSettings;
    this.providerOverrides = options.providerOverrides;
    this.baseProviderOverrides = options.providerOverrides;
    this.refreshTimeoutMs = providerRefreshDeadline(options.refreshTimeoutMs);
    this.diagnosticTimeoutMs = resolveDiagnosticTimeoutMs(
      options.diagnosticTimeoutMs,
      this.refreshTimeoutMs,
    );
    this.generation = this.createGeneration(
      this.buildRegistry(this.runtimeSettings, this.providerOverrides),
      this.providerOverrides,
    );
    this.providerClients = {
      ...this.extraClients,
    } as Record<AgentProvider, AgentClient>;
    for (const client of Object.values(this.providerClients)) this.ownedClients.add(client);
    this.installations = new ProviderInstallations({
      logger: options.logger.child({ module: "provider-installations" }),
      paseoHome: options.paseoHome,
      activity: installationActivity,
      configurationVersion: (provider) => this.installationConfigVersions.get(provider) ?? 0,
      isDiscoveryDeferred: this.readDiscoveryDeferral,
      readDiscoveredVersion: (provider) => this.readDiscoveredVersion(provider),
      readDiscoveredReleaseCheck: (provider) =>
        this.readDiscoveredInstallation(provider)?.releaseCheck,
      resolveClient: (provider) => {
        const definition = this.generation.definitions[provider];
        return definition ? this.ensureClient(provider, definition) : null;
      },
      resolveApprovedUpdateLaunch: async (provider, signal) => {
        const definition = this.generation.definitions[provider];
        if (!definition?.enabled || this.isPluginProvider(provider)) return null;
        const installation = this.ensureClient(provider, definition).installation;
        const launch = await installation?.resolveApprovedUpdateLaunch?.({ signal });
        if (this.generation.definitions[provider] !== definition) return null;
        return launch ?? null;
      },
      resolveFamily: (provider) =>
        resolveAdapter({
          provider,
          extendsOf: (id) => this.generation.definitions[id]?.derivedFromProviderId,
        }),
      refreshProvider: (provider) => this.refreshSettingsSnapshot({ providers: [provider] }),
    });
    this.refreshSchedule = options.backgroundRefresh
      ? new ProviderRefreshSchedule({
          intervalMs: options.backgroundRefresh.intervalMs,
          timers: options.backgroundRefresh.timers ?? systemProviderRefreshTimers,
          refresh: (provider) => this.refreshAllTargets([provider], "background"),
          logger: options.logger,
        })
      : null;
    this.refreshSchedule?.setProviders(this.getEnabledProviderIds());
  }

  getSnapshot(cwd?: string): ProviderSnapshot {
    const target = resolveProviderSnapshotTarget(cwd);
    return this.getSnapshotForTarget(target);
  }

  /** Read an existing published snapshot without registering a target or starting discovery. */
  peekSnapshot(cwd?: string): ProviderSnapshot | undefined {
    const target = resolveProviderSnapshotTarget(cwd);
    return this.targets.get(target.snapshotCwd)?.snapshot;
  }

  async refreshSnapshotForCwd(options: ProviderSnapshotRefreshOptions): Promise<void> {
    const snapshotCwd = resolveSnapshotCwd(options.cwd);
    const target = createWorkspaceSnapshotTarget(snapshotCwd);
    const providers = this.resolveRefreshProviders(options.providers);
    const providersToRefresh = providers ?? this.getProviderIds();
    await this.refreshProviders(target, providersToRefresh, "manual");
  }

  async refreshSettingsSnapshot(
    options: Omit<ProviderSnapshotRefreshOptions, "cwd"> = {},
  ): Promise<void> {
    const providers = this.resolveRefreshProviders(options.providers);
    await this.refreshAllTargets(providers ?? this.getProviderIds(), "manual");
  }

  private async refreshAllTargets(
    providers: AgentProvider[],
    reason: RefreshReason,
  ): Promise<void> {
    const target = createGlobalSnapshotTarget();
    const homeCwd = target.snapshotCwd;
    // An ordinary refresh must not invalidate an explicitly authorized discovery.
    const refreshable = providers.filter((provider) => !this.isProviderDiscoveryDeferred(provider));
    this.getOrCreateTarget(homeCwd);
    for (const catalogs of this.catalogs.values()) {
      for (const provider of refreshable) {
        const catalog = catalogs.get(provider);
        if (!catalog || (reason === "background" && catalog.load)) continue;
        catalogs.set(provider, {
          result: catalog.result,
          installedVersion: catalog.installedVersion,
          releaseCheck: catalog.releaseCheck,
          stale: strongerRefresh(catalog.stale, reason),
        });
      }
    }
    // Refresh each known target: provider keys coalesce reads, while target-scoped
    // providers must discover again in their own execution context.
    await this.refreshProviders(target, refreshable, reason);
    await Promise.all(
      [...this.targets.keys()]
        .filter((cwd) => cwd !== homeCwd)
        .map((cwd) => this.warmUp(createWorkspaceSnapshotTarget(cwd), refreshable)),
    );
  }

  async warmUpSnapshotForCwd(options: ProviderSnapshotWarmUpOptions): Promise<void> {
    const target = resolveProviderSnapshotTarget(options.cwd);
    const snapshotCwd = target.snapshotCwd;
    const providers = this.resolveRefreshProviders(options.providers);
    if (options.providers && providers?.length === 0) {
      return;
    }

    const providersToWarm = this.resolveProvidersToWarm(snapshotCwd, providers);
    if (providersToWarm.length === 0) {
      return;
    }
    await this.warmUp(target, providersToWarm);
  }

  async refresh(options: ProviderSnapshotRefreshOptions): Promise<void> {
    await this.refreshSnapshotForCwd(options);
  }

  listRegisteredProviderIds(): AgentProvider[] {
    return this.getProviderIds();
  }

  hasProvider(provider: AgentProvider): boolean {
    return Object.prototype.hasOwnProperty.call(this.generation.definitions, provider);
  }

  isPluginProvider(provider: AgentProvider): boolean {
    return this.pluginProviders.has(provider);
  }

  isProviderDiscoveryDeferred(provider: AgentProvider): boolean {
    // Discovery results are reusable data. They do not authorize another process launch.
    return this.generation.providerStates.get(provider)?.requiresDiscovery === true;
  }

  usesDynamicLauncher(provider: AgentProvider): boolean {
    const state = this.generation.providerStates.get(provider);
    // Synchronous callers cannot verify that a legacy replacement still selects
    // the executable seen by the last asynchronous read.
    return state?.dynamicLauncher === true || state?.checkLegacyLauncher !== undefined;
  }

  canLaunchProviderForRead(provider: AgentProvider): boolean {
    return !this.isProviderDiscoveryDeferred(provider) && !this.usesDynamicLauncher(provider);
  }

  private async blocksCurrentLegacyLauncher(provider: AgentProvider): Promise<boolean> {
    for (;;) {
      const state = this.generation.providerStates.get(provider);
      const blocked = state?.checkLegacyLauncher
        ? await state.checkLegacyLauncher()
        : state?.dynamicLauncher === true;
      if (this.generation.providerStates.get(provider) === state) return blocked;
    }
  }

  async discoverDeferredProvider(
    provider: AgentProvider,
    cwd: string | null | undefined,
    intent: DeferredDiscoveryIntent,
  ): Promise<void> {
    const state = this.generation.providerStates.get(provider);
    if (!state?.requiresDiscovery || !state.initial.entry.enabled || this.destroyed) return;
    const target = resolveProviderSnapshotTarget(cwd);
    const key = JSON.stringify([intent.kind, target.snapshotCwd]);
    const other = JSON.stringify([
      intent.kind === "create" ? "refresh" : "create",
      target.snapshotCwd,
    ]);
    let load = state.discoveryLoads.get(key);
    if (!load) {
      const previous = state.discoveryLoads.get(other) ?? Promise.resolve();
      load = previous
        .then(() => this.loadDeferredDiscovery(provider, state, target, intent))
        .finally(() => state.discoveryLoads.delete(key));
      state.discoveryLoads.set(key, load);
    }
    await load;
  }

  private async loadDeferredDiscovery(
    provider: AgentProvider,
    state: RegistryProviderState,
    target: ProviderSnapshotTarget,
    intent: DeferredDiscoveryIntent,
  ): Promise<void> {
    const current = () =>
      !this.destroyed &&
      this.generation.providerStates.get(provider)?.discoveryLoads === state.discoveryLoads;
    if (!current()) return;
    // The global ACP catalog uses the host home as its workspace.
    const cwd = target.catalogScope.scope === "global" ? homedir() : target.catalogScope.cwd;
    try {
      const runDiscovery = intent.kind === "refresh" ? await intent.prepare(cwd) : undefined;
      if (!current()) return;
      if (intent.kind === "refresh" && !runDiscovery) {
        this.setDeferredDiscoveryFailure(target.snapshotCwd, provider, state);
        return;
      }
      await this.loadProvider({
        ...target,
        provider,
        providers: [provider],
        refresh: "manual",
        allowDeferred: true,
        runDiscovery,
      });
    } catch {
      if (current()) this.setDeferredDiscoveryFailure(target.snapshotCwd, provider, state);
    }
  }

  private setDeferredDiscoveryFailure(
    cwd: string,
    provider: AgentProvider,
    state: RegistryProviderState,
  ): void {
    this.getOrCreateTarget(cwd).bindings.set(provider, {
      promise: Promise.resolve(),
      failure: identifyEntry({
        ...state.initial.entry,
        status: "error",
        error: CUSTOM_CLI_DISCOVERY_FAILED,
      }),
    });
    this.publishDiscoveryTargets(cwd);
  }

  private publishDiscoveryTargets(cwd: string): void {
    this.publishTargets(cwd === GLOBAL_PROVIDER_SNAPSHOT_KEY ? this.targets.keys() : [cwd]);
  }

  supportsConfigRequiredProvider(provider: AgentProvider): boolean {
    return this.pluginProviders.definitions()[provider]?.requiresConfiguration === true;
  }

  getProviderLabel(provider: AgentProvider): string {
    return this.generation.definitions[provider]?.label ?? provider;
  }

  getAgentManagerProviderState(): AgentManagerProviderState {
    return this.createAgentManagerState(this.generation.definitions, this.providerClients);
  }

  private createAgentManagerState(
    definitions: Record<AgentProvider, ProviderDefinition>,
    providerClients: Record<AgentProvider, AgentClient>,
  ): AgentManagerProviderState {
    const providerDefinitions: AgentManagerProviderState["providerDefinitions"] = {};
    const clients: AgentManagerProviderState["clients"] = {};
    for (const [provider, definition] of Object.entries(definitions)) {
      providerDefinitions[provider] = {
        enabled: definition.enabled,
        isDiscoveryDeferred: this.readDiscoveryDeferral,
        derivedFromProviderId: definition.derivedFromProviderId,
        applyToolPolicy: definition.applyToolPolicy,
      };
      if (definition.enabled) {
        clients[provider] = this.ensureClient(provider, definition, providerClients);
      }
    }
    for (const [provider, client] of Object.entries(this.extraClients)) {
      if (client) {
        clients[provider] = client;
      }
    }
    return { providerDefinitions, clients };
  }

  /** Called after built-in and configured plugin startup has completed, including disabled plugins. */
  settlePluginProviders(): void {
    if (this.pluginProvidersSettled) return;
    this.pluginProvidersSettled = true;
    this.warnUnknownProviderOverrides();
  }

  private warnUnknownProviderOverrides(): void {
    if (!this.pluginProvidersSettled) return;
    for (const [provider, override] of Object.entries(this.providerOverrides ?? {})) {
      if (!override.extends && !this.generation.definitions[provider]) {
        this.logger.warn({ provider }, "Provider override matches no registered provider");
      }
    }
  }

  replacePluginProviders(
    registrations: readonly ProviderRegistration[],
  ): AgentManagerProviderState {
    for (const registration of registrations) {
      if (BUILTIN_PROVIDER_IDS.includes(registration.id) || this.extraClients[registration.id]) {
        throw new Error(`Plugin provider '${registration.id}' conflicts with a built-in provider`);
      }
    }
    const previousPlugins = this.pluginProviders.definitions();
    const clients = { ...this.providerClients };
    // Materialize fallible installed clients before retiring any plugin runtime.
    this.createAgentManagerState(this.generation.definitions, clients);
    this.pluginProviders.replace(registrations);
    const plugins = this.pluginProviders.definitions();
    const retiredProviders = Object.keys(previousPlugins).filter(
      (provider) =>
        previousPlugins[provider] !== plugins[provider] &&
        !this.providerOverrides?.[provider]?.extends,
    );
    const definitions = this.buildRegistry(this.runtimeSettings, this.providerOverrides);
    const changed = new Set<AgentProvider>();
    for (const provider of new Set([...this.generation.order, ...Object.keys(definitions)])) {
      const before = this.generation.definitions[provider];
      const after = definitions[provider];
      const registrationChanged =
        previousPlugins[provider] !== plugins[provider] &&
        !this.providerOverrides?.[provider]?.extends;
      if (
        registrationChanged ||
        !before ||
        !after ||
        !isDeepStrictEqual(before.configuration, after.configuration)
      ) {
        changed.add(provider);
        delete clients[provider];
      } else {
        definitions[provider] = before;
      }
    }
    for (const client of Object.values(clients)) this.ownedClients.add(client);
    const generation = this.createGeneration(definitions, this.providerOverrides);
    const state = this.createAgentManagerState(definitions, clients);
    this.installGeneration(generation, clients, changed);
    return { ...state, retiredProviders };
  }

  private ensureClient(
    provider: AgentProvider,
    definition: ProviderDefinition,
    clients = this.providerClients,
  ): AgentClient {
    const existing = clients[provider];
    if (existing) {
      return existing;
    }
    const client = definition.createClient(this.logger);
    clients[provider] = client;
    this.ownedClients.add(client);
    return client;
  }

  async resolveUsageLaunch(provider: string) {
    if (await this.blocksCurrentLegacyLauncher(provider)) return undefined;
    const definition = this.generation.definitions[provider];
    if (!definition?.enabled || this.isProviderDiscoveryDeferred(provider)) return undefined;
    return this.ensureClient(provider, definition).resolveUsageLaunch?.();
  }

  /**
   * Whether `provider` (or a custom provider derived from it) is enabled and installed on this
   * host. Used as a hint for whether discovered usage accounts start shown.
   */
  async isProviderActiveForUsage(
    provider: string,
    options: { forceRefresh?: boolean; timeoutMs?: number; ttlMs?: number } = {},
  ): Promise<boolean> {
    const matching = this.generation.order
      .map((id) => ({ id, definition: this.generation.definitions[id] }))
      .filter(
        (candidate): candidate is { id: AgentProvider; definition: ProviderDefinition } =>
          candidate.definition !== undefined &&
          candidate.definition.enabled &&
          (candidate.id === provider || candidate.definition.derivedFromProviderId === provider),
      );
    if (matching.length === 0) return false;

    const forceRefresh = options.forceRefresh === true;
    const ttlMs = options.ttlMs ?? USAGE_PROVIDER_ACTIVITY_TTL_MS;
    const timeoutMs = options.timeoutMs ?? USAGE_PROVIDER_ACTIVITY_TIMEOUT_MS;
    const now = Date.now();

    const unresolved: Array<{ id: AgentProvider; definition: ProviderDefinition }> = [];
    if (forceRefresh) {
      unresolved.push(...matching);
    } else {
      for (const candidate of matching) {
        const cached = this.usageActivityCache.get(candidate.id);
        if (cached && now - cached.at < ttlMs) {
          if (cached.active) return true;
          continue;
        }
        unresolved.push(candidate);
      }
      if (unresolved.length === 0) return false;
    }

    const results = await Promise.all(
      unresolved.map(({ id, definition }) => this.probeUsageActivity(id, definition, timeoutMs)),
    );
    return results.some(Boolean);
  }

  private async probeUsageActivity(
    provider: AgentProvider,
    definition: ProviderDefinition,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.isProviderDiscoveryDeferred(provider)) {
      return (
        this.peekSnapshot()?.records.some(
          ({ entry }) => entry.provider === provider && entry.status === "ready",
        ) ?? false
      );
    }
    const generation = this.generation;
    if (await this.blocksCurrentLegacyLauncher(provider)) return false;
    if (this.destroyed || this.generation !== generation) return false;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.stopped.signal]);
    const timedOut = Symbol("usage-provider-activity-timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof timedOut>((finish) => {
      timer = setTimeout(() => {
        controller.abort();
        finish(timedOut);
      }, timeoutMs);
    });
    const probe = this.ensureClient(provider, definition)
      .isAvailable(signal, { scope: "global", force: true })
      .then(
        (active) => ({ ok: true as const, active }),
        () => ({ ok: false as const, active: false }),
      );
    this.trackProbe(probe.then(() => undefined));
    try {
      const outcome = await Promise.race([probe, deadline]);
      if (outcome === timedOut) {
        // Fail open without caching when a slow probe misses the deadline; a subsequent read
        // picks up the real status once the provider snapshot finishes loading.
        return true;
      }
      if (outcome.ok && !this.destroyed && this.generation === generation) {
        this.usageActivityCache.set(provider, { at: Date.now(), active: outcome.active });
      }
      return outcome.active;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async listProviders(input: ProviderSnapshotReadOptions = {}): Promise<ProviderSnapshotEntry[]> {
    const target = resolveProviderSnapshotTarget(input.cwd);
    if (input.wait) {
      await this.warmUpSnapshotForCwd({ cwd: input.cwd, providers: input.providers });
    }
    const providerFilter = input.providers ? new Set(input.providers) : null;
    const snapshot = input.wait
      ? this.getOrCreateTarget(target.snapshotCwd).snapshot
      : this.getSnapshotForTarget(target, input.providers);
    const entries = snapshot.records.map(({ entry }) => entry);
    return providerFilter ? entries.filter((entry) => providerFilter.has(entry.provider)) : entries;
  }

  async getProvider(input: ProviderSnapshotProviderOptions): Promise<ProviderSnapshotEntry> {
    const entry = (await this.listProviders({ ...input, providers: [input.provider] })).find(
      (candidate) => candidate.provider === input.provider,
    );
    if (!entry) {
      throw new Error(`Provider ${input.provider} is not configured`);
    }
    return entry;
  }

  async validateAgentConfiguration(
    input: AgentConfigurationValidationInput,
  ): Promise<HubExecutionAgentValidationIssue[]> {
    if (!this.hasProvider(input.provider)) {
      return [
        {
          path: ["provider"],
          message: `Provider '${input.provider}' is not configured`,
        },
      ];
    }

    const provider = await this.getProvider({
      provider: input.provider,
      cwd: input.cwd,
      wait: true,
    });
    if (!provider.enabled) {
      return [{ path: ["provider"], message: `Provider '${input.provider}' is disabled` }];
    }
    if (provider.status !== "ready") {
      return [
        {
          path: ["provider"],
          message:
            provider.status === "error" && provider.error
              ? provider.error
              : `Provider '${input.provider}' is not available`,
        },
      ];
    }

    return validateAgentConfigurationAgainstProvider({
      input: convertLegacyClaudeUltracode(
        input,
        resolveAdapter({
          provider: input.provider,
          extendsOf: (id) => this.generation.definitions[id]?.derivedFromProviderId,
        }),
      ),
      provider,
    });
  }

  async listModels(input: ProviderSnapshotProviderOptions): Promise<AgentModelDefinition[]> {
    const entry = await this.getReadyProvider(input);
    return filterSelectableAgentModels(entry.models);
  }

  async listModes(input: ProviderSnapshotProviderOptions): Promise<AgentMode[]> {
    const entry = await this.getReadyProvider(input);
    return entry.modes ?? [];
  }

  async resolveDefaultModel(input: ResolveDefaultModelOptions): Promise<string | undefined> {
    try {
      const trimmed = input.requestedModel?.trim();
      if (trimmed) {
        return trimmed;
      }
      const models = await this.listModels({
        provider: input.provider,
        cwd: input.cwd ? expandTilde(input.cwd) : undefined,
        wait: true,
      });
      const preferred = models.find((model) => model.isDefault) ?? models[0];
      return preferred?.id;
    } catch (error) {
      this.logger.warn({ err: error, provider: input.provider }, "Failed to resolve default model");
      return undefined;
    }
  }

  async resolveCreateConfig(
    input: ResolveProviderCreateConfigOptions,
  ): Promise<ResolvedProviderCreateConfig> {
    await this.discoverDeferredProvider(input.provider, input.cwd, { kind: "create" });
    const entry = await this.getReadyProvider({
      cwd: input.cwd,
      provider: input.provider,
      wait: true,
    });
    const definition = this.requireProvider(input.provider);
    const parent = input.parent ? this.resolveParent(input.parent) : null;
    return definition.resolveCreateConfig({
      provider: input.provider,
      requestedMode: input.requestedMode,
      providerOptions: input.providerOptions,
      parent,
      unattended: input.unattended || parent?.isUnattended === true,
      availableModes: entry.modes ?? [],
    });
  }

  async getProviderDiagnostic(provider: AgentProvider): Promise<ProviderDiagnosticResult> {
    const state = this.generation.providerStates.get(provider);
    const blocked = state?.checkLegacyLauncher
      ? await this.blocksCurrentLegacyLauncher(provider)
      : state?.dynamicLauncher === true;
    const definition = this.generation.definitions[provider];
    if (!definition) {
      return {
        provider,
        diagnostic: formatProviderDiagnostic(provider, [
          { label: "Error", value: `Provider ${provider} is not configured` },
        ]),
      };
    }

    if (blocked) {
      return {
        provider,
        diagnostic: formatProviderDiagnostic(definition.label ?? provider, [
          { label: "Status", value: "CLI is checked when opening an agent" },
        ]),
      };
    }

    if (this.isProviderDiscoveryDeferred(provider)) {
      const entry = this.peekSnapshot()?.records.find(
        (record) => record.entry.provider === provider,
      )?.entry;
      return {
        provider,
        diagnostic: formatProviderDiagnostic(definition.label ?? provider, [
          {
            label: "Status",
            value:
              entry?.status === "error" || entry?.status === "ready"
                ? formatProviderStatus(entry)
                : "Awaiting explicit provider discovery",
          },
        ]),
      };
    }
    const baseDiagnosticPromise = this.getBaseProviderDiagnostic(provider, definition);
    const snapshotEntryPromise = this.refreshDiagnosticSnapshotEntry(provider);
    const [baseDiagnostic, entry] = await Promise.all([
      baseDiagnosticPromise,
      snapshotEntryPromise,
    ]);

    const modelCount = entry.status === "ready" ? String(entry.models?.length ?? 0) : "—";
    const status = formatProviderStatus(entry);
    const diagnostic = `${baseDiagnostic}\n  Models: ${modelCount}\n  Status: ${status}`;
    return { provider, diagnostic };
  }

  applyMutableProviderConfig(
    mutableProviders: MutableDaemonConfig["providers"] | undefined,
    options: ApplyMutableProviderConfigOptions = {},
  ): AgentManagerProviderState {
    const prepared = this.prepareMutableProviderConfig(mutableProviders, options);
    prepared.commit();
    return prepared.agentManagerState;
  }

  prepareMutableProviderConfig(
    mutableProviders: MutableDaemonConfig["providers"] | undefined,
    options: ApplyMutableProviderConfigOptions = {},
  ): PreparedMutableProviderConfig {
    const baseProviderOverrides = options.replace
      ? undefined
      : omitProviderOverrides(this.baseProviderOverrides, options.removeProviders ?? []);
    const runtimeSettings = options.replace ? undefined : this.runtimeSettings;
    const providerOverrides = applyMutableProviderConfigToOverrides(
      baseProviderOverrides,
      mutableProviders,
    );
    const definitions = this.buildRegistry(runtimeSettings, providerOverrides);
    const changed = new Set<AgentProvider>();
    const clients = { ...this.providerClients };
    for (const provider of new Set([...this.generation.order, ...Object.keys(definitions)])) {
      const before = this.generation.definitions[provider];
      const after = definitions[provider];
      if (
        !before ||
        !after ||
        !isDeepStrictEqual(runtimeConfiguration(before), runtimeConfiguration(after))
      ) {
        changed.add(provider);
        delete clients[provider];
      } else if (before.label === after.label && before.description === after.description) {
        definitions[provider] = before;
      }
    }
    Object.assign(clients, this.extraClients);
    const generation = this.createGeneration(definitions, providerOverrides, changed);
    for (const [provider, state] of generation.providerStates) {
      if (
        state.requiresDiscovery !== this.generation.providerStates.get(provider)?.requiresDiscovery
      )
        changed.add(provider);
    }
    const agentManagerState = this.createAgentManagerState(definitions, clients);
    return {
      agentManagerState,
      commit: () => {
        this.baseProviderOverrides = baseProviderOverrides;
        this.runtimeSettings = runtimeSettings;
        this.providerOverrides = providerOverrides;
        this.installGeneration(generation, clients, changed);
      },
    };
  }

  private installGeneration(
    generation: RegistryGeneration,
    clients: Record<AgentProvider, AgentClient>,
    changed: ReadonlySet<AgentProvider>,
  ): void {
    for (const provider of changed) {
      this.generation.providerStates.get(provider)?.discoveryLimit.clearQueue();
      this.usageActivityCache.delete(provider);
    }
    this.updateInstallationConfigVersions(generation);
    this.generation = generation;
    this.providerClients = clients;
    this.warnUnknownProviderOverrides();
    for (const [key, catalogs] of this.catalogs) {
      for (const provider of changed) catalogs.delete(provider);
      if (catalogs.size === 0) this.catalogs.delete(key);
    }
    for (const target of this.targets.values()) {
      for (const provider of changed) target.bindings.delete(provider);
    }
    this.publishTargets(this.targets.keys());
    this.refreshSchedule?.setProviders(this.getEnabledProviderIds());
    this.refreshSchedule?.recordRefresh([...changed]);
    const providers = [...changed].filter((provider) => generation.definitions[provider]);
    if (providers.length === 0) return;
    for (const cwd of this.targets.keys()) {
      void this.warmUp(
        resolveProviderSnapshotTarget(cwd === GLOBAL_PROVIDER_SNAPSHOT_KEY ? undefined : cwd),
        providers,
      );
    }
  }

  private updateInstallationConfigVersions(next: RegistryGeneration): void {
    const previous = this.generation;
    for (const provider of new Set([...previous.order, ...next.order])) {
      if (
        sameInstallationConfiguration(previous.definitions[provider], next.definitions[provider]) &&
        previous.providerStates.get(provider)?.requiresDiscovery ===
          next.providerStates.get(provider)?.requiresDiscovery
      ) {
        continue;
      }
      const version = this.installationConfigVersions.get(provider) ?? 0;
      this.installationConfigVersions.set(provider, version + 1);
    }
  }

  setRefreshTimeoutMs(refreshTimeoutMs: number | undefined): void {
    this.refreshTimeoutMs = providerRefreshDeadline(refreshTimeoutMs);
    this.diagnosticTimeoutMs = resolveDiagnosticTimeoutMs(undefined, this.refreshTimeoutMs);
  }

  on(event: "change", listener: ProviderSnapshotChangeListener): this {
    this.events.on(event, listener);
    return this;
  }

  off(event: "change", listener: ProviderSnapshotChangeListener): this {
    this.events.off(event, listener);
    return this;
  }

  async shutdown(): Promise<void> {
    const closingUpdates = this.stop();
    void closingUpdates.catch(() => undefined);
    // A running probe stops at its next activity boundary and cleans up what it started, so no
    // provider starts work after its client shuts down.
    await withTimeout(
      Promise.allSettled(this.runningProbes),
      PROBE_SHUTDOWN_GRACE_MS,
      "Provider probes did not stop before shutdown",
    ).catch((error) =>
      this.logger.warn({ err: error }, "Shutting down providers with probes running"),
    );
    // Materialize a client per enabled provider so provider-owned resources
    // (background processes, sockets, etc.) get a chance to release even when
    // a given provider hasn't been touched yet during this daemon's lifetime.
    try {
      await closingUpdates;
    } finally {
      this.getAgentManagerProviderState();
      await shutdownAgentClients(this.ownedClients, this.logger);
    }
  }

  destroy(): void {
    void this.stop().catch((error: unknown) => {
      this.logger.warn({ err: error }, "Provider updater cleanup failed");
    });
    this.catalogs.clear();
    this.targets.clear();
    this.events.removeAllListeners();
  }

  private stop(): Promise<void> {
    this.destroyed = true;
    this.refreshSchedule?.dispose();
    const closingUpdates = this.installations.close();
    for (const state of this.generation.providerStates.values()) state.discoveryLimit.clearQueue();
    this.stopped.abort(new Error("Provider snapshot manager stopped"));
    return closingUpdates;
  }

  private buildRegistry(
    runtimeSettings: AgentProviderRuntimeSettingsMap | undefined,
    providerOverrides: Record<string, ProviderOverride> | undefined,
  ): Record<AgentProvider, ProviderDefinition> {
    const registry = buildProviderRegistry(this.logger, {
      runtimeSettings,
      providerOverrides,
      pluginProviders: this.pluginProviders.definitions(),
      workspaceGitService: this.workspaceGitService,
      managedProcesses: this.managedProcesses,
      openCodeBridge: this.openCodeBridge,
      isDev: this.isDev,
    });

    for (const [provider, client] of Object.entries(this.extraClients) as Array<
      [AgentProvider, AgentClient]
    >) {
      const definition = registry[provider];
      if (!definition) continue;
      registry[provider] = {
        ...definition,
        createClient: () => client,
        resolveCreateConfig:
          client.resolveCreateConfig?.bind(client) ?? definition.resolveCreateConfig,
        isCreateConfigUnattended:
          client.isCreateConfigUnattended?.bind(client) ?? definition.isCreateConfigUnattended,
        fetchCatalog: (options, _client, context) => client.fetchCatalog(options, context),
      };
    }

    return registry;
  }

  private resolveParent(parent: ManagedAgent): AgentCreateConfigParent {
    const definition = this.requireProvider(parent.provider);
    return {
      provider: parent.provider,
      modeId: parent.currentModeId,
      isUnattended: definition.isCreateConfigUnattended({
        modeId: parent.currentModeId,
        // Provider defaults from `config.json` apply to the parent too, so classify on the
        // effective options while the stored overrides stay as they are.
        config: {
          ...parent.config,
          providerOptions: parent.effectiveOptions ?? parent.config.providerOptions,
        },
        controls: parent.controls,
        availableModes: parent.availableModes ?? definition.modes ?? [],
      }),
    };
  }

  private getSnapshotForTarget(
    target: ProviderSnapshotTarget,
    providers?: AgentProvider[],
  ): ProviderSnapshot {
    const providersToWarm = this.resolveProvidersToWarm(target.snapshotCwd, providers);
    if (providersToWarm.length > 0) {
      void this.warmUp(target, providersToWarm);
    }
    return this.getOrCreateTarget(target.snapshotCwd).snapshot;
  }

  private async getReadyProvider(
    input: ProviderSnapshotProviderOptions,
  ): Promise<ProviderSnapshotEntry> {
    const entry = await this.getProvider(input);
    if (!entry.enabled) {
      throw new Error(`Provider '${entry.provider}' is disabled`);
    }
    if (entry.status === "ready") {
      return entry;
    }
    if (entry.status === "error") {
      throw new Error(entry.error ?? `Failed to load provider '${entry.provider}'`);
    }
    throw new Error(`Provider '${entry.provider}' is not available`);
  }

  private requireProvider(provider: AgentProvider): ProviderDefinition {
    const definition = this.generation.definitions[provider];
    if (!definition) {
      throw new Error(`Provider ${provider} is not configured`);
    }
    return definition;
  }

  private async refreshDiagnosticSnapshotEntry(
    provider: AgentProvider,
  ): Promise<ProviderSnapshotEntry> {
    try {
      const target = createGlobalSnapshotTarget();
      await this.refreshProviders(target, [provider], "manual");
      return await this.getProvider({ provider, wait: false });
    } catch (error) {
      return {
        ...this.generation.providerStates.get(provider)!.initial.entry,
        status: "error",
        error: toErrorMessage(error),
      };
    }
  }

  private async getBaseProviderDiagnostic(
    provider: AgentProvider,
    definition: ProviderDefinition,
  ): Promise<string> {
    try {
      const client = this.ensureClient(provider, definition);
      if (client.getDiagnostic) {
        return (
          await withTimeout(
            client.getDiagnostic({
              // The report and the Installation row show one answer for the version.
              inspectInstallation: async () =>
                (await this.installations.inspect(provider, { refresh: true }))?.inspection,
            }),
            this.diagnosticTimeoutMs,
            `Timed out collecting ${definition.label ?? provider} diagnostic after ${
              this.diagnosticTimeoutMs
            }ms`,
          )
        ).diagnostic;
      }
      return formatProviderDiagnostic(definition.label ?? provider, [
        { label: "Diagnostic", value: "No diagnostic available" },
      ]);
    } catch (error) {
      return formatProviderDiagnosticError(definition.label ?? provider, error);
    }
  }

  private createGeneration(
    definitions: Record<AgentProvider, ProviderDefinition>,
    overrides: Record<string, ProviderOverride> | undefined,
    changed?: ReadonlySet<AgentProvider>,
  ): RegistryGeneration {
    const order = Object.keys(definitions);
    const providerStates = new Map<AgentProvider, RegistryProviderState>();
    for (const provider of order) {
      const definition = definitions[provider]!;
      const requiresDiscovery = providerRequiresDiscovery(
        overrides,
        provider,
        definition.derivedFromProviderId,
      );
      const previous = this.generation?.providerStates.get(provider);
      const priorDefinition = this.generation?.definitions[provider];
      if (previous?.requiresDiscovery === requiresDiscovery && priorDefinition === definition) {
        providerStates.set(provider, previous);
        continue;
      }
      const custom =
        this.pluginProviders.has(provider) ||
        (!BUILTIN_PROVIDER_IDS.includes(provider) && !!overrides?.[provider]?.extends);
      const reuseDiscovery =
        previous?.requiresDiscovery === requiresDiscovery && changed && !changed.has(provider);
      const dynamicLauncher = providerNamesDynamicLauncher(definition);
      const state: RegistryProviderState = {
        requiresDiscovery,
        dynamicLauncher,
        discoveryLoads: reuseDiscovery ? previous.discoveryLoads : new Map(),
        discoveryLimit: previous?.discoveryLimit ?? pLimit({ concurrency: 4, rejectOnClear: true }),
        initial: initialProviderRecord(
          provider,
          definition,
          requiresDiscovery,
          custom,
          dynamicLauncher,
        ),
      };
      providerStates.set(provider, state);
      this.checkLegacyLauncher(provider, definition, state, custom);
    }
    return { definitions, order, providerStates };
  }

  private checkLegacyLauncher(
    provider: AgentProvider,
    definition: ProviderDefinition,
    state: RegistryProviderState,
    custom: boolean,
  ): void {
    const runtimeSettings = definition.configuration?.runtimeSettings;
    const command = runtimeSettings?.command;
    if (
      !definition.enabled ||
      state.requiresDiscovery ||
      state.dynamicLauncher ||
      command?.mode !== "replace"
    )
      return;

    const regularInitial = state.initial;
    let pending: Promise<boolean> | undefined;
    const classify = async (): Promise<boolean> => {
      const blocked = await isDynamicProviderLauncher(
        command.argv,
        createProviderEnv({ runtimeSettings }),
      );
      if (state.dynamicLauncher === blocked) return blocked;
      state.dynamicLauncher = blocked;
      state.initial = blocked
        ? initialProviderRecord(provider, definition, false, custom, true)
        : regularInitial;
      if (this.generation?.providerStates.get(provider) === state) {
        if (blocked) this.clearLegacyLauncherCatalogs(provider);
        this.publishTargets(this.targets.keys());
      }
      return blocked;
    };
    state.checkLegacyLauncher = () =>
      (pending ??= classify().finally(() => {
        pending = undefined;
      }));
    void state.checkLegacyLauncher();
  }

  private clearLegacyLauncherCatalogs(provider: AgentProvider): void {
    for (const [key, catalogs] of this.catalogs) {
      catalogs.delete(provider);
      if (catalogs.size === 0) this.catalogs.delete(key);
    }
    for (const target of this.targets.values()) target.bindings.delete(provider);
  }

  private async warmUp(target: ProviderSnapshotTarget, providers?: AgentProvider[]): Promise<void> {
    const providersToRefresh = providers ?? this.getProviderIds();

    await this.loadProviders({
      snapshotCwd: target.snapshotCwd,
      catalogScope: target.catalogScope,
      providers: providersToRefresh,
    });
  }

  private async refreshProviders(
    target: ProviderSnapshotTarget,
    providers: AgentProvider[],
    reason: RefreshReason,
  ): Promise<void> {
    this.refreshSchedule?.recordRefresh(providers);
    await this.loadProviders({
      snapshotCwd: target.snapshotCwd,
      catalogScope: target.catalogScope,
      providers,
      refresh: reason,
    });
  }

  private resolveProvidersToWarm(cwd: string, providers?: AgentProvider[]): AgentProvider[] {
    this.getOrCreateTarget(cwd);
    // Identity is provider-owned and may change without a daemon config reload.
    return providers ?? this.getProviderIds();
  }

  private async loadProviders(options: ProviderLoadOptions): Promise<void> {
    await Promise.allSettled(
      options.providers.map((provider) => this.loadProvider({ ...options, provider })),
    );
  }

  private loadProvider(options: ProviderLoadOptions & { provider: AgentProvider }): Promise<void> {
    const state = this.generation.providerStates.get(options.provider);
    if (this.destroyed || !state || (state.requiresDiscovery && !options.allowDeferred))
      return Promise.resolve();
    if (!state.checkLegacyLauncher) {
      return state.dynamicLauncher ? Promise.resolve() : this.loadAllowedProvider(options);
    }
    return this.blocksCurrentLegacyLauncher(options.provider).then((blocked) => {
      if (blocked || this.destroyed) return undefined;
      if (this.generation.providerStates.get(options.provider) !== state) {
        return this.loadProvider(options);
      }
      return this.loadAllowedProvider(options);
    });
  }

  private loadAllowedProvider(
    options: ProviderLoadOptions & { provider: AgentProvider },
  ): Promise<void> {
    const { bindings } = this.getOrCreateTarget(options.snapshotCwd);
    const binding: CatalogBinding = {
      key: bindings.get(options.provider)?.key,
      failure: bindings.get(options.provider)?.failure,
      refresh: strongerRefresh(options.refresh, bindings.get(options.provider)?.refresh),
      promise: Promise.resolve(),
    };
    bindings.set(options.provider, binding);
    const resolveCatalog = () =>
      this.resolveCatalog({ ...options, refresh: binding.refresh }, binding);
    binding.promise = options.runDiscovery
      ? options.runDiscovery(resolveCatalog)
      : resolveCatalog();
    return binding.promise;
  }

  private async resolveCatalog(
    options: ProviderLoadOptions & { provider: AgentProvider },
    binding: CatalogBinding,
  ): Promise<void> {
    const { provider, snapshotCwd, refresh } = options;
    const definition = this.generation.definitions[provider]!;
    const state = this.generation.providerStates.get(provider)!;
    const { entry: initial } = state.initial;
    this.getOrCreateTarget(snapshotCwd);
    if (!definition.enabled) return;
    const currentBinding = () => this.targets.get(snapshotCwd)?.bindings.get(provider);
    const client = this.ensureClient(provider, definition);
    // Only a requested refresh asks the provider to bypass its own caches or rotate servers.
    const catalogOptions = createFetchCatalogOptions(options.catalogScope, refresh === "manual");
    let key: string;
    try {
      const sharedKey = client.getCatalogCacheKey
        ? await withTimeout(
            client.getCatalogCacheKey(catalogOptions),
            this.refreshTimeoutMs,
            `Timed out resolving ${provider} catalogue key`,
          )
        : await Promise.resolve(undefined);
      key = JSON.stringify(
        state.requiresDiscovery || sharedKey === undefined
          ? ["target", snapshotCwd]
          : ["provider", sharedKey],
      );
    } catch (error) {
      if (currentBinding() !== binding) return currentBinding()?.promise;
      binding.refresh = undefined;
      binding.key = undefined;
      binding.failure = identifyEntry({
        ...this.generation.providerStates.get(provider)!.initial.entry,
        status: "error",
        error: state.requiresDiscovery ? CUSTOM_CLI_DISCOVERY_FAILED : toErrorMessage(error),
      });
      if (state.requiresDiscovery) this.publishDiscoveryTargets(snapshotCwd);
      else this.publishTargets([snapshotCwd]);
      return;
    }
    // Only the latest key resolution for this target may bind it to a catalogue.
    if (currentBinding() !== binding) return currentBinding()?.promise;
    binding.refresh = undefined;
    binding.key = key;
    binding.failure = undefined;
    let catalogs = this.catalogs.get(key);
    if (!catalogs) {
      catalogs = new Map();
      this.catalogs.set(key, catalogs);
    }
    let catalog = catalogs.get(provider);
    if (!catalog) {
      catalog = {};
      catalogs.set(provider, catalog);
    }
    this.publishTargets([snapshotCwd]);
    if (refresh !== "manual" && catalog.load) return catalog.load;
    if (!refresh && catalog.result && !catalog.stale) return;
    const background = strongerRefresh(refresh, catalog.stale) === "background";
    catalog.stale = undefined;

    const current = catalog;
    const recordDiscoveredVersion = snapshotCwd === GLOBAL_PROVIDER_SNAPSHOT_KEY;
    const isCurrent = (): boolean =>
      !this.destroyed && this.catalogs.get(key)?.get(provider) === current && current.load === load;
    const load = this.generation.providerStates
      .get(provider)!
      .discoveryLimit(async () => {
        if (state.checkLegacyLauncher && (await state.checkLegacyLauncher())) return;
        if (!isCurrent()) return;
        return this.trackProbe(
          this.refreshProvider({
            catalogOptions,
            provider,
            definition,
            initial,
            redactErrors: state.requiresDiscovery,
            client,
            publish: (entry, { incomplete, installedVersion, releaseCheck }) => {
              if (!isCurrent()) return false;
              const result = identifyEntry(structuredClone(entry));
              const boundTargets =
                state.requiresDiscovery && snapshotCwd === GLOBAL_PROVIDER_SNAPSHOT_KEY
                  ? [...this.targets.keys()]
                  : [...this.targets].flatMap(([cwd, target]) =>
                      target.bindings.get(provider)?.key === key ? [cwd] : [],
                    );
              const isGlobal =
                catalogOptions.scope === "global" ||
                boundTargets.includes(resolveProviderSnapshotTarget().snapshotCwd);
              if (
                background &&
                current.result &&
                keepsPublishedResult({ published: current.result, next: result, incomplete })
              ) {
                if (entry.status !== "ready" || incomplete) {
                  this.logger.warn(
                    {
                      provider,
                      target: catalogOptions,
                      status: entry.status,
                      incomplete,
                      error: entry.error,
                    },
                    "Background provider refresh failed; keeping the last catalogue",
                  );
                }
                if (
                  isGlobal &&
                  (entry.status === "ready" ||
                    (entry.status === "unavailable" && current.result.entry.status !== "ready"))
                ) {
                  this.usageActivityCache.set(provider, {
                    at: Date.now(),
                    active: entry.status === "ready",
                  });
                }
                return false;
              }
              current.result = result;
              if (
                recordDiscoveredVersion &&
                (options.runDiscovery || (state.checkLegacyLauncher && releaseCheck))
              ) {
                current.installedVersion = installedVersion;
                current.releaseCheck = releaseCheck;
              }
              if (isGlobal) this.cacheUsageActivity(provider, entry.status);
              this.publishTargets(boundTargets);
              return true;
            },
          }),
        );
      })
      .finally(() => {
        if (current.load === load) current.load = undefined;
      });
    current.load = load;
    return load;
  }

  private cacheUsageActivity(
    provider: AgentProvider,
    status: ProviderSnapshotEntry["status"],
  ): void {
    if (status === "ready" || status === "unavailable") {
      this.usageActivityCache.set(provider, { at: Date.now(), active: status === "ready" });
    }
  }

  private trackProbe(probe: Promise<void>): Promise<void> {
    this.runningProbes.add(probe);
    const forget = () => this.runningProbes.delete(probe);
    probe.then(forget, forget);
    return probe;
  }

  private async refreshProvider(options: {
    catalogOptions: FetchCatalogOptions;
    provider: AgentProvider;
    definition: ProviderDefinition;
    initial: ProviderSnapshotEntry;
    redactErrors: boolean;
    client: AgentClient;
    publish: (
      entry: ProviderSnapshotEntry,
      result: {
        incomplete: boolean;
        installedVersion?: string;
        releaseCheck?: DiscoveredReleaseCheck;
      },
    ) => boolean;
  }): Promise<void> {
    const {
      catalogOptions,
      provider,
      definition,
      initial: base,
      redactErrors,
      client,
      publish: setEntry,
    } = options;

    try {
      const catalog = await runProviderRefreshWithDeadline({
        label: definition.label,
        timeoutMs: this.refreshTimeoutMs,
        signal: this.stopped.signal,
        operation: async (context) => {
          const available = await context.runActivity("availability", () =>
            raceProviderRefreshAbort(
              context.signal,
              client.isAvailable(context.signal, catalogOptions),
            ),
          );
          if (!available) {
            return null;
          }

          return await definition.fetchCatalog(catalogOptions, client, context);
        },
      });
      if (!catalog) {
        setEntry({ ...base, status: "unavailable", enabled: true }, { incomplete: false });
        return;
      }

      const models = normalizeAgentModelCatalog(catalog.models);
      if (models.length !== catalog.models.length) {
        this.logger.warn(
          { provider, discardedRows: catalog.models.length - models.length },
          "Provider catalog contains repeated model IDs; retaining the first definition",
        );
      }
      setEntry(
        {
          ...base,
          defaultModeId:
            catalog.defaultModeId === undefined ? base.defaultModeId : catalog.defaultModeId,
          status: "ready",
          enabled: true,
          models,
          modes: catalog.modes,
          fetchedAt: new Date().toISOString(),
        },
        {
          incomplete: catalog.incomplete === true,
          installedVersion: safeDiscoveredVersion(catalog.installedVersion),
          releaseCheck: (
            catalog as typeof catalog & {
              [discoveredReleaseCheck]?: DiscoveredReleaseCheck;
            }
          )[discoveredReleaseCheck],
        },
      );
    } catch (error) {
      const emitted = setEntry(
        {
          ...base,
          status: "error",
          enabled: true,
          error: redactErrors ? CUSTOM_CLI_DISCOVERY_FAILED : toErrorMessage(error),
        },
        { incomplete: false },
      );
      if (emitted) {
        this.logger.warn(
          redactErrors
            ? { provider, category: "custom_cli_discovery_failed" }
            : { err: error, provider, target: catalogOptions },
          "Failed to refresh provider snapshot",
        );
      }
    }
  }

  private publishTargets(cwds: Iterable<string>): void {
    if (this.destroyed) return;
    const transitions: ProviderSnapshotTransition[] = [];
    for (const cwd of cwds) {
      const target = this.targets.get(cwd)!;
      const records = this.generation.order.map((provider) => {
        return this.readSnapshotRecord(provider, cwd, target);
      });
      const previous = target.snapshot;
      if (sameSnapshotRecords(previous.records, records)) continue;
      const current = { cwd, records };
      target.snapshot = current;
      transitions.push({ previous, current });
    }
    for (const transition of transitions) {
      for (const listener of this.events.listeners("change")) {
        try {
          listener(transition);
        } catch (error) {
          this.logger.error(
            { err: error, cwd: transition.current.cwd },
            "Provider snapshot subscriber failed",
          );
        }
      }
    }
  }

  private getOrCreateTarget(cwd: string): Target {
    let target = this.targets.get(cwd);
    if (!target) {
      target = {
        bindings: new Map(),
        snapshot: {
          cwd,
          records: this.generation.order.map((provider) => this.readSnapshotRecord(provider, cwd)),
        },
      };
      this.targets.set(cwd, target);
    }
    return target;
  }

  private readSnapshotRecord(provider: AgentProvider, cwd: string, target?: Target) {
    const state = this.generation.providerStates.get(provider)!;
    const result = this.boundCatalogRecord(target, provider);
    // Settings discovery can populate workspace pickers without authorizing a process there.
    const global =
      state.requiresDiscovery && cwd !== GLOBAL_PROVIDER_SNAPSHOT_KEY
        ? this.boundCatalogRecord(this.targets.get(GLOBAL_PROVIDER_SNAPSHOT_KEY), provider)
        : undefined;
    return withProviderDisplay(
      result ?? (global?.entry.status === "ready" ? global : state.initial),
      state.initial,
    );
  }

  private boundCatalogRecord(target: Target | undefined, provider: AgentProvider) {
    const binding = target?.bindings.get(provider);
    return (
      binding?.failure ??
      (binding?.key ? this.catalogs.get(binding.key)?.get(provider)?.result : undefined)
    );
  }

  private readDiscoveredVersion(provider: AgentProvider): string | undefined {
    return this.readDiscoveredInstallation(provider)?.installedVersion;
  }

  private readDiscoveredInstallation(provider: AgentProvider): ProviderCatalog | undefined {
    const binding = this.targets.get(GLOBAL_PROVIDER_SNAPSHOT_KEY)?.bindings.get(provider);
    if (!binding?.key || binding.failure) return undefined;
    return this.catalogs.get(binding.key)?.get(provider);
  }

  private getProviderIds(): AgentProvider[] {
    return [...this.generation.order];
  }

  private getEnabledProviderIds(): AgentProvider[] {
    return this.generation.order.filter(
      (provider) => this.generation.definitions[provider]!.enabled,
    );
  }

  private resolveRefreshProviders(providers?: AgentProvider[]): AgentProvider[] | undefined {
    if (!providers || providers.length === 0) {
      return undefined;
    }

    const providerIds = new Set(this.getProviderIds());
    return Array.from(new Set(providers)).filter((provider) => providerIds.has(provider));
  }
}

export function resolveSnapshotCwd(cwd?: string | null): string {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    return homedir();
  }
  let expanded =
    trimmed === "~" || trimmed.startsWith("~/") ? `${homedir()}${trimmed.slice(1)}` : trimmed;
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(expanded)) {
    expanded = `${expanded}\\`;
  }
  let resolved = resolve(expanded);
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(resolved)) {
    resolved = `${resolved}\\`;
  }
  return resolved;
}

function resolveProviderSnapshotTarget(cwd?: string | null): ProviderSnapshotTarget {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    return createGlobalSnapshotTarget();
  }
  return createWorkspaceSnapshotTarget(resolveSnapshotCwd(trimmed));
}

function createGlobalSnapshotTarget(): ProviderSnapshotTarget {
  return {
    snapshotCwd: GLOBAL_PROVIDER_SNAPSHOT_KEY,
    catalogScope: { scope: "global" },
  };
}

function createWorkspaceSnapshotTarget(cwd: string): ProviderSnapshotTarget {
  const snapshotCwd = resolveSnapshotCwd(cwd);
  return {
    snapshotCwd,
    catalogScope: { scope: "workspace", cwd: snapshotCwd },
  };
}

function createFetchCatalogOptions(
  scope: ProviderCatalogScope,
  force: boolean,
): FetchCatalogOptions {
  return scope.scope === "global"
    ? { scope: "global", force }
    : { scope: "workspace", cwd: scope.cwd, force };
}

export function isGlobalProviderSnapshotKey(cwd: string): boolean {
  return cwd === GLOBAL_PROVIDER_SNAPSHOT_KEY;
}

function identifyEntry(entry: ProviderSnapshotEntry): ProviderSnapshotRecord {
  const { fetchedAt: _fetchedAt, ...content } = entry;
  const contentHash = createHash("sha256")
    .update(JSON.stringify(["paseo.provider-result/1", content]))
    .digest("base64url");
  return { entry, contentHash };
}

/**
 * A background result replaces neither unchanged content nor a ready catalogue with a result that
 * is not ready or is incomplete. Providers report a failed startup probe as unavailable, so it
 * counts as transient too.
 */
function keepsPublishedResult(options: {
  published: ProviderSnapshotRecord;
  next: ProviderSnapshotRecord;
  incomplete: boolean;
}): boolean {
  const { published, next, incomplete } = options;
  return (
    published.contentHash === next.contentHash ||
    (published.entry.status === "ready" && (next.entry.status !== "ready" || incomplete))
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return "Unknown error";
}

function formatProviderStatus(entry: ProviderSnapshotEntry): string {
  if (entry.status === "ready") return "Ready";
  if (entry.status === "error") return `Error: ${entry.error ?? "Unknown error"}`;
  if (entry.status === "unavailable") return "Unavailable";
  return "Loading";
}

export function sameSnapshotRecords(
  previous: readonly ProviderSnapshotRecord[],
  current: readonly ProviderSnapshotRecord[],
): boolean {
  return (
    previous.length === current.length &&
    previous.every((before, index) => {
      const after = current[index]!;
      return (
        before === after ||
        (before.entry.provider === after.entry.provider &&
          before.contentHash === after.contentHash &&
          before.entry.fetchedAt === after.entry.fetchedAt)
      );
    })
  );
}
