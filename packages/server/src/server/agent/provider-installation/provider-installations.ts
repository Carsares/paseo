import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Logger } from "pino";
import type {
  ProviderInstallation,
  ProviderInstallationInspection,
  ProviderInstallationUpdate,
  ProviderInstallationUpdateCheck,
  ProviderInstallationUpdateCleared,
  ProviderInstallationUpdateProgress,
} from "@getpaseo/protocol/messages";
import {
  ProviderInspectionSchema,
  ProviderUpdateCheckSchema,
  ProviderUpdateReportSchema,
  ProviderUpdateResultSchema,
} from "@getpaseo/plugin/server/provider";
import type {
  AgentClient,
  AgentClientInstallation,
  AgentClientInstallationContext,
  AgentClientUpdateContext,
  AgentProvider,
  FetchCatalogOptions,
  InstallationMaintenance,
  InstallationUpdateResult,
  ProviderRefreshContext,
} from "../agent-sdk-types.js";
import { runApprovedUpdateCommand } from "../providers/update-command.js";
import { InstallationActivity } from "./installation-activity.js";
import {
  acquireApprovedUpdateFileLock,
  acquireProviderUpdateFileLock,
  ApprovedUpdateAdmissionError,
  readInstallationActivityKeys,
  supportsHostApprovedProviderUpdates,
} from "./installation-target.js";
import { readApprovedProviderUpdater } from "./local-updater-plan-store.js";
import { ProviderUpdateOperation } from "./provider-update-operation.js";
import { sanitizeUpdateProgress, sanitizeUpdateResultMessage } from "./update-output.js";

const DEFAULT_INSPECT_TIMEOUT_MS = 20_000;
const DEFAULT_INSPECT_CACHE_MS = 30_000;
// Below the plugin RPC timeout, so a slow plugin check reports this deadline.
const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 25_000;
const DEFAULT_UPDATE_CHECK_CACHE_MS = 60 * 60_000;
/** Characters of updater output kept per update; older output is dropped first. */
export const DEFAULT_UPDATE_OUTPUT_LIMIT = 64 * 1024;

const CONFIG_CHANGED = "Provider configuration changed. Inspect the installation and retry.";
const UPDATE_UNVERIFIED =
  "The updater completed for the previous configuration. Inspect the current installation to verify its version.";
const UNPROVEN_UPDATE = "Paseo could not verify a local update plan for this installation.";
const HOST_APPROVAL_UNAVAILABLE = "Host-approved provider updates are unavailable on this host.";
const DAEMON_STOPPING = "The daemon is stopping.";

class UpdateRefusal extends Error {}

export class ProviderUpdateCleanupError extends Error {
  constructor() {
    super("Could not confirm that every provider updater process stopped.");
  }
}

const PROVIDER_UPDATE_REFUSAL_MESSAGES = {
  manual: "This installation must be updated outside Paseo.",
  external: "Update this installation on the host that manages it.",
};

function maintenanceRefusal(
  kind: keyof typeof PROVIDER_UPDATE_REFUSAL_MESSAGES,
  message: string | undefined,
): string {
  return sanitizeUpdateResultMessage(message) ?? PROVIDER_UPDATE_REFUSAL_MESSAGES[kind];
}

function isApprovalOnlyInstallation(installation: AgentClientInstallation): boolean {
  return Boolean(
    installation.resolveApprovedUpdateLaunch &&
    !installation.installUrl &&
    !installation.updateUrl &&
    !installation.inspect &&
    !installation.inspectionSnapshot &&
    !installation.getMaintenance &&
    !installation.checkForUpdates &&
    !installation.update,
  );
}

function parseUpdateResult(answer: unknown): InstallationUpdateResult {
  const result = ProviderUpdateResultSchema.parse(answer);
  if (
    result.status !== "succeeded" ||
    !answer ||
    typeof answer !== "object" ||
    !("outcome" in answer)
  ) {
    return result;
  }
  const { outcome } = answer;
  if (outcome === "updated" || outcome === "already_current" || outcome === "unverified") {
    return { ...result, outcome };
  }
  return result;
}

export interface ProviderInstallationsOptions {
  logger: Logger;
  /** The current client for a configured provider, or null when the provider is unknown. */
  resolveClient(provider: AgentProvider): AgentClient | null;
  /** True when installation reads must not launch the provider. */
  isDiscoveryDeferred?(provider: AgentProvider): boolean;
  /** Version already published by authorized settings discovery for this configuration. */
  readDiscoveredVersion?(provider: AgentProvider): string | undefined;
  readDiscoveredReleaseCheck?(provider: AgentProvider): DiscoveredReleaseCheck | undefined;
  resolveFamily?(provider: AgentProvider): string;
  /** Changes only when this provider's configuration is published. */
  configurationVersion?(provider: AgentProvider): number;
  activity?: InstallationActivity;
  inspectTimeoutMs?: number;
  inspectCacheMs?: number;
  updateCheckTimeoutMs?: number;
  /** How long a conclusive update check is reused. Failed checks use `inspectCacheMs`. */
  updateCheckCacheMs?: number;
  /** Rediscovers the provider after a successful update. A failure is logged, not reported. */
  refreshProvider?(provider: AgentProvider): Promise<void>;
  /** Host-owned configuration directory containing the local updater plan file. */
  paseoHome?: string;
  /** Returns the current absolute launch entry before symlinks, using lookup without child processes. */
  resolveApprovedUpdateLaunch?(
    provider: AgentProvider,
    signal: AbortSignal,
  ): Promise<string | null>;
  updateOutputLimit?: number;
  now?: () => number;
}

/** What an update observer hears, shaped as the message the session forwards to its clients. */
export type ProviderUpdateEvent =
  | { type: "provider.installation.update.progress"; payload: ProviderInstallationUpdateProgress }
  | { type: "provider.installation.update.cleared"; payload: ProviderInstallationUpdateCleared };

export type ProviderUpdateListener = (event: ProviderUpdateEvent) => void;

export interface InspectProviderInstallationOptions {
  /** Skip the settled-result cache. Joins a call that is already running. */
  refresh?: boolean;
}

interface ProviderCall<T> {
  name: string;
  /** A cached result is reused only for the same key. */
  key?: string | object;
  timeoutMs: number;
  /** How long a settled result is reused. */
  cacheMs(result: T): number;
  run(context: AgentClientInstallationContext): Promise<T>;
  failed(message: string): T;
}

interface CachedRead<T> {
  key: string | object | undefined;
  promise: Promise<T>;
  settledAt: number | null;
  cacheMs: number;
}

/** Catalog-only data. Resolving and running the check must never launch the configured CLI. */
export interface DiscoveredReleaseCheck {
  inspectFiles(): Promise<"current" | "missing" | "changed">;
  isReleaseSourceCurrent?(): Promise<boolean>;
  run?(signal: AbortSignal): Promise<ProviderInstallationUpdateCheck>;
}

export const discoveredReleaseCheck = Symbol("discoveredReleaseCheck");

export const readStaticCatalogMetadata = Symbol("readStaticCatalogMetadata");

export interface StaticCatalogMetadata {
  defaultModeId?: string;
  installedVersion?: string;
  [discoveredReleaseCheck]?: DiscoveredReleaseCheck;
}

export interface StaticCatalogMetadataReader {
  [readStaticCatalogMetadata]?(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<StaticCatalogMetadata | undefined>;
}

interface InstallationInspectionSnapshot {
  inspection: ProviderInstallationInspection;
  maintenance?: InstallationMaintenance;
}

interface ProviderUpdateTask {
  provider: AgentProvider;
  client: AgentClient;
  version: number;
  operation: ProviderUpdateOperation;
  controller: AbortController;
  run?(context: AgentClientUpdateContext): Promise<unknown>;
  planId?: string;
  discoveryDeferredAtStart: boolean;
}

interface PreparedUpdate {
  keys: string[];
  run(context: AgentClientUpdateContext): Promise<unknown>;
}

async function waitForInspection<T>(signal: AbortSignal, inspect: () => Promise<T>): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    return await Promise.race([
      inspect(),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Calls provider installation callbacks for every provider, built-in or plugin, through
 * `AgentClient.installation`. Owns deadlines, in-flight sharing and result caching. Results are
 * keyed by client and, when provided, by the runtime choice within that client.
 * An update check first reads the inspection and passes its version to the provider, so the
 * installed version never waits on an update check.
 */
export class ProviderInstallations {
  private readonly logger: Logger;
  private readonly resolveClient: ProviderInstallationsOptions["resolveClient"];
  private readonly isDiscoveryDeferred: NonNullable<
    ProviderInstallationsOptions["isDiscoveryDeferred"]
  >;
  private readonly readDiscoveredVersion: NonNullable<
    ProviderInstallationsOptions["readDiscoveredVersion"]
  >;
  private readonly activity: InstallationActivity;
  private readonly configurationVersion: NonNullable<
    ProviderInstallationsOptions["configurationVersion"]
  >;
  private readonly resolveFamily: NonNullable<ProviderInstallationsOptions["resolveFamily"]>;
  private readonly inspectTimeoutMs: number;
  private readonly inspectCacheMs: number;
  private readonly updateCheckTimeoutMs: number;
  private readonly updateCheckCacheMs: number;
  private readonly refreshProvider: ProviderInstallationsOptions["refreshProvider"];
  private readonly paseoHome: ProviderInstallationsOptions["paseoHome"];
  private readonly resolveApprovedUpdateLaunch: ProviderInstallationsOptions["resolveApprovedUpdateLaunch"];
  private readonly updateOutputLimit: number;
  private readonly now: () => number;
  private readonly updates = new Map<AgentProvider, ProviderUpdateOperation>();
  private readonly updateListeners = new Map<AgentProvider, Set<ProviderUpdateListener>>();
  private readonly runningUpdates = new Map<AbortController, Promise<void>>();
  private readonly approvedOperations = new WeakMap<
    ProviderUpdateOperation,
    { key: string; client: AgentClient; version: number }
  >();
  private shutdown: Promise<void> | undefined;
  private hasUnconfirmedCleanup = false;
  private readonly inspections = new WeakMap<
    AgentClient,
    CachedRead<InstallationInspectionSnapshot>
  >();
  private readonly updateChecks = new WeakMap<
    AgentClient,
    CachedRead<ProviderInstallationUpdateCheck>
  >();
  private readonly readDiscoveredReleaseCheck: NonNullable<
    ProviderInstallationsOptions["readDiscoveredReleaseCheck"]
  >;

  constructor(options: ProviderInstallationsOptions) {
    this.logger = options.logger;
    this.resolveClient = options.resolveClient;
    this.isDiscoveryDeferred = options.isDiscoveryDeferred ?? (() => false);
    this.readDiscoveredVersion = options.readDiscoveredVersion ?? (() => undefined);
    this.readDiscoveredReleaseCheck = options.readDiscoveredReleaseCheck ?? (() => undefined);
    this.configurationVersion = options.configurationVersion ?? (() => 0);
    this.activity = options.activity ?? new InstallationActivity();
    this.resolveFamily = options.resolveFamily ?? ((provider) => provider);
    this.inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
    this.inspectCacheMs = options.inspectCacheMs ?? DEFAULT_INSPECT_CACHE_MS;
    this.updateCheckTimeoutMs = options.updateCheckTimeoutMs ?? DEFAULT_UPDATE_CHECK_TIMEOUT_MS;
    this.updateCheckCacheMs = options.updateCheckCacheMs ?? DEFAULT_UPDATE_CHECK_CACHE_MS;
    this.refreshProvider = options.refreshProvider;
    this.paseoHome = options.paseoHome;
    this.resolveApprovedUpdateLaunch = options.resolveApprovedUpdateLaunch;
    this.updateOutputLimit = options.updateOutputLimit ?? DEFAULT_UPDATE_OUTPUT_LIMIT;
    this.now = options.now ?? Date.now;
  }

  /** Links and installed state, or null when the provider declares no installation contract. */
  async inspect(
    provider: AgentProvider,
    options: InspectProviderInstallationOptions = {},
  ): Promise<ProviderInstallation | null> {
    const client = this.requireClient(provider);
    const installation = client.installation;
    if (!installation) return null;
    if (options.refresh) this.clearFailedUpdate(provider);
    const result: ProviderInstallation = {};
    if (installation.installUrl) result.installUrl = installation.installUrl;
    if (installation.updateUrl) result.updateUrl = installation.updateUrl;
    const version = this.configurationVersion(provider);
    if (isApprovalOnlyInstallation(installation)) {
      const planId = await this.readApprovedUpdatePlanId(provider);
      this.withApprovedPlanId(provider, version, client, result, planId);
      return result.approvedUpdatePlanId ? result : null;
    }
    if (this.isDiscoveryDeferred(provider)) {
      const planId = await this.readApprovedUpdatePlanId(provider);
      if (!this.sameConfiguration(provider, version, client)) return result;
      const inspection = await this.inspectDiscoveredInstallation(provider);
      if (!this.sameConfiguration(provider, version, client)) return result;
      if (inspection) result.inspection = inspection;
      return this.withApprovedPlanId(provider, version, client, result, planId);
    }
    const [snapshot, standaloneMaintenance, planId] = await Promise.all([
      this.readInspection(provider, client, options),
      installation.inspectionSnapshot ? undefined : this.readMaintenance(provider, client),
      this.readApprovedUpdatePlanId(provider),
    ]);
    if (this.isDiscoveryDeferred(provider)) return result;
    const ordinary = await this.inspectOrdinaryUpdate(
      provider,
      client,
      version,
      snapshot?.maintenance ?? standaloneMaintenance,
    );
    if (this.isDiscoveryDeferred(provider)) return result;
    Object.assign(result, ordinary);
    if (snapshot) result.inspection = snapshot.inspection;
    return this.withApprovedPlanId(provider, version, client, result, planId);
  }

  private async inspectOrdinaryUpdate(
    provider: AgentProvider,
    client: AgentClient,
    version: number,
    maintenance: InstallationMaintenance | undefined,
  ): Promise<Pick<ProviderInstallation, "maintenance" | "canUpdate">> {
    let details = maintenance ? { maintenance } : {};
    if (maintenance?.kind === "external") return details;
    const isCurrent = () =>
      !this.shutdown &&
      !this.isDiscoveryDeferred(provider) &&
      this.sameConfiguration(provider, version, client);
    if (client.installation?.update && maintenance?.kind === "automatic") {
      const keys = await this.readActivityKeys(client);
      if (keys.length > 0) return isCurrent() ? { ...details, canUpdate: true } : details;
      details = { maintenance: { kind: "manual", message: UNPROVEN_UPDATE } };
    }
    return details;
  }

  private withApprovedPlanId(
    provider: AgentProvider,
    version: number,
    client: AgentClient,
    result: ProviderInstallation,
    planId: string | undefined,
  ): ProviderInstallation {
    if (
      planId &&
      !this.shutdown &&
      result.maintenance?.kind !== "external" &&
      this.sameConfiguration(provider, version, client)
    ) {
      result.approvedUpdatePlanId = planId;
    }
    return result;
  }

  private async inspectDiscoveredInstallation(
    provider: AgentProvider,
  ): Promise<ProviderInstallationInspection | undefined> {
    const version = this.readDiscoveredVersion(provider);
    if (version === undefined) return undefined;
    const evidence = this.readDiscoveredReleaseCheck(provider);
    // Providers that publish runtime metadata without file evidence retain their existing contract.
    if (!evidence) return { status: "installed", version };
    const status = await this.readDiscoveredFileStatus(evidence);
    if (this.readDiscoveredReleaseCheck(provider) !== evidence) return undefined;
    if (status === "missing") return { status: "not_installed" };
    if (status === "changed") {
      return {
        status: "error",
        message: "The CLI installation changed. Refresh provider discovery to verify its version.",
      };
    }
    return { status: "installed", version };
  }

  private readDiscoveredFileStatus(evidence: DiscoveredReleaseCheck) {
    return waitForInspection(
      AbortSignal.timeout(this.inspectTimeoutMs),
      evidence.inspectFiles,
    ).catch(() => "changed" as const);
  }

  /**
   * Whether a newer version is available, as the provider reports it, or null when the provider
   * cannot check. A check that throws or misses its deadline is reported as `error`.
   */
  async checkForUpdates(
    provider: AgentProvider,
    options: InspectProviderInstallationOptions = {},
  ): Promise<ProviderInstallationUpdateCheck | null> {
    if (this.isDiscoveryDeferred(provider)) {
      return this.checkDiscoveredUpdates(provider, options);
    }
    const client = this.requireClient(provider);
    const installation = client.installation;
    const checkForUpdates = installation?.checkForUpdates;
    if (!installation || !checkForUpdates) return null;
    // The provider compares the version the inspection reported, so a cached answer holds only
    // while the inspection still reports that version.
    const inspection = (await this.readInspection(provider, client, options))?.inspection;
    if (this.isDiscoveryDeferred(provider)) return null;
    if (inspection?.status === "not_installed")
      return { status: "unknown", message: "Not installed" };
    if (inspection?.status === "error") return { status: "error", message: inspection.message };
    const installedVersion = inspection?.version;
    return this.read(provider, client, this.updateChecks, options, {
      name: "update check",
      key: installedVersion,
      timeoutMs: this.updateCheckTimeoutMs,
      // Inconclusive answers are retried soon; a conclusive one holds for the long cache.
      cacheMs: (result) =>
        result.status === "current" || result.status === "available"
          ? this.updateCheckCacheMs
          : this.inspectCacheMs,
      run: async (context) =>
        ProviderUpdateCheckSchema.parse(
          await checkForUpdates.call(installation, { ...context, installedVersion }),
        ),
      failed: (message) => ({ status: "error" as const, message }),
    });
  }

  private async checkDiscoveredUpdates(
    provider: AgentProvider,
    options: InspectProviderInstallationOptions,
  ): Promise<ProviderInstallationUpdateCheck | null> {
    if (!this.readDiscoveredVersion(provider)) return null;
    const check = this.readDiscoveredReleaseCheck(provider);
    if (!check) return null;
    const unknown = { status: "unknown", message: "The CLI's release source is unknown." } as const;
    const run = check.run;
    const client = this.requireClient(provider);
    const version = this.configurationVersion(provider);
    const isCurrent = () =>
      this.sameConfiguration(provider, version, client) &&
      this.readDiscoveredReleaseCheck(provider) === check;
    const matchesInstallation = async () => {
      if ((await this.readDiscoveredFileStatus(check)) !== "current") return false;
      return check.isReleaseSourceCurrent
        ? waitForInspection(
            AbortSignal.timeout(this.inspectTimeoutMs),
            check.isReleaseSourceCurrent,
          ).catch(() => false)
        : true;
    };
    if (!run || !(await matchesInstallation()) || !isCurrent()) return unknown;
    const answer = await this.read(provider, client, this.updateChecks, options, {
      name: "discovered release check",
      key: check,
      timeoutMs: this.updateCheckTimeoutMs,
      cacheMs: (result) =>
        result.status === "current" || result.status === "available"
          ? this.updateCheckCacheMs
          : this.inspectCacheMs,
      run: async ({ signal }) => ProviderUpdateCheckSchema.parse(await run(signal)),
      failed: () => ({
        status: "error" as const,
        message: "Could not check the CLI's release source.",
      }),
    });
    return isCurrent() && (await matchesInstallation()) && isCurrent() ? answer : unknown;
  }

  /**
   * Starts the provider's update, or returns the one already running. The update runs until the
   * provider settles it, independent of any client; only `close` aborts it. Throws when the
   * provider declares no `update`.
   */
  update(provider: AgentProvider, options?: { planId: string }): ProviderInstallationUpdate {
    if (options) {
      if (!supportsHostApprovedProviderUpdates()) throw new Error(HOST_APPROVAL_UNAVAILABLE);
      if (!this.paseoHome || !this.resolveApprovedUpdateLaunch) throw new Error(UNPROVEN_UPDATE);
      return this.startUpdate(provider, options.planId);
    }
    return this.startUpdate(provider);
  }

  private startUpdate(provider: AgentProvider, planId?: string): ProviderInstallationUpdate {
    if (this.shutdown) throw new Error(DAEMON_STOPPING);
    const running = this.updates.get(provider);
    if (running?.running) {
      const activeApproval = this.approvedOperations.get(running);
      if (
        activeApproval?.key !== planId ||
        (activeApproval &&
          !this.sameConfiguration(provider, activeApproval.version, activeApproval.client))
      )
        throw new Error("An update is already in progress for this installation.");
      return running.snapshot();
    }
    const discoveryDeferredAtStart = this.isDiscoveryDeferred(provider);
    if (planId === undefined && discoveryDeferredAtStart) {
      throw new Error("Update this installation on the host using its original installer.");
    }
    const client = this.requireClient(provider);
    const installation = client.installation;
    const update = installation?.update;
    if (!installation || (planId === undefined && !update))
      throw new Error(`Provider ${provider} cannot update itself`);
    const operation = new ProviderUpdateOperation({
      id: randomUUID(),
      provider,
      startedAt: this.timestamp(),
      outputLimit: this.updateOutputLimit,
      publish: (progress) =>
        this.publishUpdate(provider, {
          type: "provider.installation.update.progress",
          payload: progress,
        }),
    });
    const version = this.configurationVersion(provider);
    if (planId !== undefined)
      this.approvedOperations.set(operation, { key: planId, client, version });
    this.updates.set(provider, operation);
    const controller = new AbortController();
    const task = Promise.resolve()
      .then(() =>
        this.runUpdate({
          provider,
          client,
          operation,
          controller,
          version,
          planId,
          discoveryDeferredAtStart,
          run: update && ((context) => update.call(installation, context)),
        }),
      )
      .finally(() => {
        this.runningUpdates.delete(controller);
      });
    this.runningUpdates.set(controller, task);
    void task.catch(() => {
      this.hasUnconfirmedCleanup = true;
      this.logger.error({ provider }, "Provider update did not settle normally");
    });
    operation.publishStarted();
    return operation.snapshot();
  }

  /**
   * The latest update of the provider since the daemon started, or null. An explicit installation
   * refresh clears a failed update.
   */
  getUpdate(provider: AgentProvider): ProviderInstallationUpdate | null {
    return this.updates.get(provider)?.snapshot() ?? null;
  }

  /**
   * Calls `listener` when an update of the provider starts, reports output or settles, and when
   * a refresh drops a failed update.
   */
  observeUpdates(provider: AgentProvider, listener: ProviderUpdateListener): () => void {
    let listeners = this.updateListeners.get(provider);
    if (!listeners) {
      listeners = new Set();
      this.updateListeners.set(provider, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.updateListeners.delete(provider);
    };
  }

  private publishUpdate(provider: AgentProvider, event: ProviderUpdateEvent): void {
    for (const listener of this.updateListeners.get(provider) ?? []) {
      try {
        listener(event);
      } catch {
        this.logger.warn({ provider }, "Could not notify a provider update listener");
      }
    }
  }

  /** Close admission before aborting and keep each task registered through its process cleanup. */
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    const updates = [...this.runningUpdates];
    this.shutdown = Promise.allSettled(updates.map(([, task]) => task)).then((results) => {
      if (this.hasUnconfirmedCleanup || results.some((result) => result.status === "rejected")) {
        throw new ProviderUpdateCleanupError();
      }
      return undefined;
    });
    for (const [controller] of updates) controller.abort(new UpdateRefusal(DAEMON_STOPPING));
    return this.shutdown;
  }

  private clearFailedUpdate(provider: AgentProvider): void {
    const failed = this.updates.get(provider);
    if (!failed?.failed) return;
    this.updates.delete(provider);
    this.publishUpdate(provider, {
      type: "provider.installation.update.cleared",
      payload: { provider, operationId: failed.id },
    });
  }

  private readInspection(
    provider: AgentProvider,
    client: AgentClient,
    options: InspectProviderInstallationOptions,
  ): Promise<InstallationInspectionSnapshot> | undefined {
    const installation = client.installation;
    if (!installation) return undefined;
    const snapshot = installation.inspectionSnapshot;
    const inspect = installation.inspect;
    if (!snapshot && !inspect) return undefined;
    return this.read(provider, client, this.inspections, options, {
      name: "inspect",
      key: snapshot?.cacheKey(),
      timeoutMs: this.inspectTimeoutMs,
      cacheMs: () => this.inspectCacheMs,
      run: async (context) => {
        const { inspection, maintenance } = snapshot
          ? await snapshot.read(context)
          : { inspection: await inspect?.call(installation, context), maintenance: undefined };
        return { inspection: ProviderInspectionSchema.parse(inspection), maintenance };
      },
      failed: (message) => ({
        inspection: { status: "error", message },
        ...(snapshot ? { maintenance: { kind: "manual", message: UNPROVEN_UPDATE } } : {}),
      }),
    });
  }

  private async readMaintenance(
    provider: AgentProvider,
    client: AgentClient,
    parentSignal?: AbortSignal,
  ): Promise<InstallationMaintenance | undefined> {
    const installation = client.installation;
    const getMaintenance = installation?.getMaintenance;
    if (!getMaintenance) return undefined;
    const timeout = AbortSignal.timeout(this.inspectTimeoutMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    try {
      return await waitForInspection(signal, () => getMaintenance.call(installation, { signal }));
    } catch {
      if (!parentSignal?.aborted)
        this.logger.warn({ provider }, "Provider maintenance could not be verified");
      return { kind: "manual", message: UNPROVEN_UPDATE };
    }
  }

  private async readActivityKeys(
    client: AgentClient,
    parentSignal?: AbortSignal,
  ): Promise<string[]> {
    const installation = client.installation;
    const getActivityKeys = installation?.getActivityKeys;
    if (!getActivityKeys) return [];
    const deadline = AbortSignal.timeout(this.inspectTimeoutMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
    try {
      const keys = await waitForInspection(signal, () => getActivityKeys.call(installation));
      if (keys.includes("opaque")) return [];
      return keys.filter((key) => key.trim().length > 0);
    } catch {
      return [];
    }
  }

  private sameConfiguration(
    provider: AgentProvider,
    version: number,
    client: AgentClient,
  ): boolean {
    return (
      this.configurationVersion(provider) === version && this.resolveClient(provider) === client
    );
  }

  private isCurrentUpdate(task: ProviderUpdateTask): boolean {
    return (
      (task.planId !== undefined || !this.isDiscoveryDeferred(task.provider)) &&
      this.sameConfiguration(task.provider, task.version, task.client)
    );
  }

  private reportProgress(
    provider: AgentProvider,
    operation: ProviderUpdateOperation,
    report: unknown,
  ): void {
    const parsed = ProviderUpdateReportSchema.safeParse(report);
    if (!parsed.success) {
      this.logger.warn({ provider }, "Ignored invalid provider update output");
      return;
    }
    const text = sanitizeUpdateProgress(parsed.data.text);
    if (text) operation.append({ type: "message", text });
    else if (parsed.data.text) operation.markOutputTruncated();
  }

  private async executeUpdate(task: ProviderUpdateTask): Promise<InstallationUpdateResult> {
    const { provider, controller, operation, planId } = task;
    const { signal } = controller;
    let spawnAuthorized = false;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!this.isCurrentUpdate(task)) throw new UpdateRefusal(CONFIG_CHANGED);
    };
    assertCurrent();
    const { keys, run } =
      planId === undefined
        ? await this.prepareOrdinaryUpdate(task, assertCurrent)
        : await this.prepareHostApprovedUpdate(provider, planId, signal, assertCurrent);

    const lease = this.activity.acquireUpdate({
      family: this.resolveFamily(provider),
      keys,
      // A host approval binds the launch and updater identities, but not the updater's write scope.
      opaque: planId !== undefined,
    });
    let releaseFileLock: (() => Promise<void>) | undefined;
    let releaseApprovalLock: (() => Promise<void>) | undefined;
    let cleanupUnconfirmed = false;
    try {
      if (supportsHostApprovedProviderUpdates()) {
        const release = await acquireProviderUpdateFileLock().catch(() => {
          throw new UpdateRefusal("Could not lock provider updates for this host.");
        });
        if (!release)
          throw new UpdateRefusal(
            "Provider updates are locked for this account. Check for an active updater.",
          );
        releaseFileLock = release;
      }
      assertCurrent();
      if (planId !== undefined) {
        releaseApprovalLock = await acquireApprovedUpdateFileLock().catch((error) => {
          throw new UpdateRefusal(
            error instanceof ApprovedUpdateAdmissionError
              ? error.message
              : "Could not verify provider agent activity for this account.",
          );
        });
        assertCurrent();
      }
      const result = parseUpdateResult(
        await run({
          signal,
          assertCurrent: () => {
            assertCurrent();
            spawnAuthorized = true;
          },
          quarantineActivity: () => {
            cleanupUnconfirmed = true;
            this.hasUnconfirmedCleanup = true;
            lease.quarantine();
          },
          report: (event) => this.reportProgress(provider, operation, event),
        }),
      );
      if (!this.isCurrentUpdate(task)) {
        if (result.status === "succeeded" && spawnAuthorized) {
          return { status: "succeeded", outcome: "unverified", message: UPDATE_UNVERIFIED };
        }
        throw new UpdateRefusal(CONFIG_CHANGED);
      }
      if (result.status === "succeeded" && !spawnAuthorized)
        throw new UpdateRefusal(UNPROVEN_UPDATE);
      const message = sanitizeUpdateResultMessage(result.message);
      if (result.status === "failed") {
        return { status: "failed", message: message ?? "The updater failed." };
      }
      signal.throwIfAborted();
      return { ...result, message };
    } finally {
      if (!cleanupUnconfirmed && releaseApprovalLock) {
        await releaseApprovalLock().catch(() => {
          this.logger.warn({ provider }, "Could not release the approved provider update lock");
        });
      }
      if (!cleanupUnconfirmed && releaseFileLock) {
        await releaseFileLock().catch(() => {
          this.logger.warn({ provider }, "Could not release the provider update lock");
        });
      }
      lease.release();
    }
  }

  private async prepareOrdinaryUpdate(
    task: ProviderUpdateTask,
    assertCurrent: () => void,
  ): Promise<PreparedUpdate> {
    const {
      provider,
      client,
      controller: { signal },
      run,
    } = task;
    const maintenance = await this.readMaintenance(provider, client, signal);
    assertCurrent();
    if (maintenance?.kind === "external")
      throw new UpdateRefusal(maintenanceRefusal(maintenance.kind, maintenance.message));
    if (run && maintenance?.kind === "automatic") {
      const keys = await this.readActivityKeys(client, signal);
      assertCurrent();
      if (keys.length > 0) return { keys, run };
    }
    if (maintenance?.kind === "manual")
      throw new UpdateRefusal(maintenanceRefusal(maintenance.kind, maintenance.message));
    throw new UpdateRefusal(UNPROVEN_UPDATE);
  }

  private async prepareHostApprovedUpdate(
    provider: AgentProvider,
    planId: string,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<PreparedUpdate> {
    const { paseoHome, resolveApprovedUpdateLaunch } = this;
    if (!paseoHome || !resolveApprovedUpdateLaunch) throw new UpdateRefusal(UNPROVEN_UPDATE);
    const reread = async () => {
      assertCurrent();
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.inspectTimeoutMs)]);
      const plan = await waitForInspection(deadline, async () => {
        const launchPath = await resolveApprovedUpdateLaunch(provider, deadline);
        if (!launchPath || !isAbsolute(launchPath)) return null;
        return readApprovedProviderUpdater({
          paseoHome,
          provider,
          launchPath,
          planId,
          signal: deadline,
        });
      });
      assertCurrent();
      return plan?.provider === provider && plan.planId === planId ? plan : null;
    };
    const plan = await reread();
    if (!plan) throw new UpdateRefusal(UNPROVEN_UPDATE);
    const launchKeys = await readInstallationActivityKeys(plan.launchPath);
    if (launchKeys.length === 0) throw new UpdateRefusal(UNPROVEN_UPDATE);
    const keys = [
      ...launchKeys,
      ...(await readInstallationActivityKeys(plan.updater.resolvedCommand)),
    ];
    const expected = JSON.stringify(plan);
    const readEnv = () =>
      Object.fromEntries(
        ["HOME", "LANG", "LC_ALL", "TMPDIR", "PATH"].map((key) => [key, process.env[key]]),
      );
    const env = readEnv();
    const verify = async () => {
      if (
        JSON.stringify(await reread()) !== expected ||
        JSON.stringify(readEnv()) !== JSON.stringify(env)
      )
        throw new UpdateRefusal(UNPROVEN_UPDATE);
    };
    return {
      keys,
      async run(context) {
        await verify();
        return runApprovedUpdateCommand(
          {
            command: plan.updater.resolvedCommand,
            args: [...plan.updater.args],
            env,
            verifyBeforeSpawn: verify,
          },
          context,
        );
      },
    };
  }

  private async readApprovedUpdatePlanId(provider: AgentProvider): Promise<string | undefined> {
    const { paseoHome, resolveApprovedUpdateLaunch } = this;
    if (
      !supportsHostApprovedProviderUpdates() ||
      !paseoHome ||
      !resolveApprovedUpdateLaunch ||
      this.shutdown
    )
      return;
    const signal = AbortSignal.timeout(this.inspectTimeoutMs);
    try {
      return await waitForInspection(signal, async () => {
        const launchPath = await resolveApprovedUpdateLaunch(provider, signal);
        if (!launchPath || !isAbsolute(launchPath)) return;
        const plans = await readApprovedProviderUpdater({
          paseoHome,
          provider,
          launchPath,
          signal,
        });
        if (plans.length === 1) return plans[0]?.planId;
      });
    } catch {
      return;
    }
  }

  private async runUpdate(task: ProviderUpdateTask): Promise<void> {
    const { provider, version, client, operation } = task;
    let result: InstallationUpdateResult;
    try {
      result = await this.executeUpdate(task);
    } catch (error) {
      this.logger.warn({ provider }, "Provider update failed");
      let message: string | undefined;
      if (error instanceof UpdateRefusal) message = error.message;
      else if (error instanceof Error) message = sanitizeUpdateResultMessage(error.message);
      result = { status: "failed", message: message ?? "The updater failed." };
    }
    // A config commit may run between the update promise settling and publication.
    const current = this.isCurrentUpdate(task);
    if (result.status === "succeeded" && !current) {
      result = { status: "succeeded", outcome: "unverified", message: UPDATE_UNVERIFIED };
    }
    if (result.status === "succeeded" && current) {
      this.inspections.delete(client);
      this.updateChecks.delete(client);
    }
    operation.settle(result, this.timestamp());
    if (!current || result.status !== "succeeded" || task.discoveryDeferredAtStart) return;
    if (
      task.planId !== undefined &&
      client.installation &&
      isApprovalOnlyInstallation(client.installation)
    )
      return;
    const refresh = this.refreshProvider;
    if (!refresh) return;
    void Promise.resolve()
      .then(() => {
        if (
          !this.shutdown &&
          !this.isDiscoveryDeferred(provider) &&
          this.sameConfiguration(provider, version, client)
        )
          return refresh(provider);
        return undefined;
      })
      .catch(() => {
        this.logger.warn({ provider }, "Provider refresh after update failed");
      });
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private requireClient(provider: AgentProvider): AgentClient {
    const client = this.resolveClient(provider);
    if (!client) throw new Error(`Provider ${provider} is not configured`);
    return client;
  }

  private read<T>(
    provider: AgentProvider,
    client: AgentClient,
    cache: WeakMap<AgentClient, CachedRead<T>>,
    options: InspectProviderInstallationOptions,
    call: ProviderCall<T>,
  ): Promise<T> {
    const existing = cache.get(client);
    if (
      existing &&
      existing.key === call.key &&
      (existing.settledAt === null || (!options.refresh && this.isFresh(existing)))
    ) {
      return existing.promise;
    }
    // invoke settles asynchronously, after `read` is initialized.
    const promise = this.invoke(provider, call).then((result) => {
      read.settledAt = this.now();
      read.cacheMs = call.cacheMs(result);
      return result;
    });
    const read: CachedRead<T> = { key: call.key, promise, settledAt: null, cacheMs: 0 };
    cache.set(client, read);
    return read.promise;
  }

  private isFresh(read: CachedRead<unknown>): boolean {
    return read.settledAt !== null && this.now() - read.settledAt < read.cacheMs;
  }

  private async invoke<T>(provider: AgentProvider, call: ProviderCall<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Timed out after ${call.timeoutMs}ms`);
        reject(error);
        controller.abort(error);
      }, call.timeoutMs);
    });
    try {
      return await Promise.race([call.run({ signal: controller.signal }), deadline]);
    } catch (error) {
      this.logger.warn({ err: error, provider }, `Provider installation ${call.name} failed`);
      return call.failed(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}
