import { createHash } from "node:crypto";
import type { AgentUsageSession } from "../../agent/agent-sdk-types.js";
import type { UsageScope } from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import type { Logger } from "pino";
import {
  UsageReportSchema,
  type ProviderUsage,
  type UsageReportEntry,
  type UsageProblem,
  type UsageReport,
} from "@getpaseo/protocol/messages";

export interface UsageSource {
  id: string;
  label: string;
  icon?: string;
  provider?: string;
  discover(scope: UsageScope): Promise<unknown>;
  fetch(input: unknown): Promise<unknown>;
}

interface Login {
  input: unknown;
  harness: string;
}

interface KnownReport {
  source: UsageSource;
  logins: [Login, ...Login[]];
  label?: string;
  globalLaunchRevision?: number;
}

type KnownReports = Map<string, KnownReport>;

interface DiscoveredSource {
  expiresAt: number;
  reports: KnownReports;
}

interface DiscoveryScope {
  sources: Map<UsageSource, DiscoveredSource>;
  pending: Map<UsageSource, Promise<void>>;
  active: number;
}

interface AgentReports {
  sessionKey: string;
  signature: string;
  reports: KnownReports;
}

const DISCOVERY_RETRY_MS = 5_000;
const SESSION_DISCOVERY_LIMIT = 128;

function createDiscoveryScope(): DiscoveryScope {
  return { sources: new Map(), pending: new Map(), active: 0 };
}

export interface AgentUsageLookup {
  hasAgent(id: string): boolean;
  usageSession(id: string): AgentUsageSession | null;
  resolveLaunch?(
    provider: string,
  ): Promise<import("@getpaseo/plugin/server/provider").ProviderLaunch | undefined>;
}

export interface ListUsageReportsOptions {
  forceRefresh?: boolean;
  reportIds?: string[];
  agentId?: string;
  onReport?: (report: UsageReportEntry) => void;
}

/** Groups discovered logins by account and caches their usage for five minutes. */
export class UsageSourceRegistry {
  private readonly sources = new Map<string, UsageSource>();
  private readonly known: KnownReports = new Map();
  private defaults: KnownReports = new Map();
  private readonly byAgent = new Map<string, AgentReports>();
  private globalDiscovery = createDiscoveryScope();
  private readonly launchRevisions = new WeakMap<UsageSource, number>();
  private readonly sessionDiscovery = new Map<string, DiscoveryScope>();
  private readonly cache = new Map<string, { at: number; entry: UsageReportEntry }>();
  private readonly successful = new Map<string, NonNullable<UsageReportEntry["lastSuccessful"]>>();
  private readonly pending = new Map<string, Promise<UsageReportEntry | undefined>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 300_000,
    private readonly logger: Pick<Logger, "warn"> = { warn: console.warn },
    private readonly agents: AgentUsageLookup = { hasAgent: () => false, usageSession: () => null },
    private readonly deadlineMs = 20_000,
  ) {}

  register(source: UsageSource): void {
    if (this.sources.has(source.id)) throw new Error(`Duplicate usage source: ${source.id}`);
    // A registration has its own lifetime, even when a caller reuses the source object.
    this.sources.set(source.id, {
      id: source.id,
      label: source.label,
      icon: source.icon,
      provider: source.provider,
      discover: (scope) => source.discover(scope),
      fetch: (input) => source.fetch(input),
    });
    this.invalidateDiscovery();
  }

  unregister(id: string): void {
    if (!this.sources.delete(id)) return;
    this.invalidateDiscovery();
    for (const key of this.defaults.keys()) if (key.startsWith(`${id}:`)) this.defaults.delete(key);
    for (const { reports } of this.byAgent.values()) {
      for (const key of reports.keys()) if (key.startsWith(`${id}:`)) reports.delete(key);
    }
    for (const key of this.known.keys()) if (key.startsWith(`${id}:`)) this.known.delete(key);
    for (const key of this.cache.keys()) if (key.startsWith(`${id}:`)) this.cache.delete(key);
    for (const key of this.successful.keys())
      if (key.startsWith(`${id}:`)) this.successful.delete(key);
    for (const key of this.pending.keys()) if (key.startsWith(`${id}:`)) this.pending.delete(key);
  }

  invalidateProviderLaunches(providers: ReadonlySet<string>): void {
    const changed = new Set<UsageSource>();
    for (const source of this.sources.values()) {
      if (!source.provider || !providers.has(source.provider)) continue;
      changed.add(source);
      this.launchRevisions.set(source, this.launchRevision(source) + 1);
      this.globalDiscovery.sources.delete(source);
      this.globalDiscovery.pending.delete(source);
    }
    if (changed.size === 0) return;
    // A config edit changes the default launch. Live agents keep their original
    // launch. Clear fetches that used host discoveries, including shared logins.
    for (const reports of [this.defaults, this.known]) {
      for (const [id, report] of reports) {
        if (report.globalLaunchRevision === undefined || !changed.has(report.source)) continue;
        const key = cacheIdentity(id, report);
        this.cache.delete(key);
        this.successful.delete(key);
        this.pending.delete(key);
        reports.delete(id);
      }
    }
    this.mergeKnown();
  }

  private launchRevision(source: UsageSource): number {
    return this.launchRevisions.get(source) ?? 0;
  }

  async listReports(options: ListUsageReportsOptions = {}): Promise<UsageReportEntry[]> {
    if (options.agentId !== undefined && options.reportIds !== undefined)
      throw new Error("agentId and reportIds cannot be combined");
    this.pruneAgents();
    let ids: string[];
    const { agentId, forceRefresh = false, reportIds } = options;
    let agent: AgentReports | null = null;
    let reports = this.known;
    if (options.agentId !== undefined) {
      if (!this.agents.hasAgent(options.agentId))
        throw new Error(`Unknown agent: ${options.agentId}`);
      agent = await this.discoverAgent(options.agentId, forceRefresh);
      this.mergeKnown();
      if (!agent) return [];
      reports = agent.reports;
      ids = [...reports.keys()];
    } else if (reportIds !== undefined) {
      ids = reportIds;
    } else {
      await Promise.all([
        this.discoverDefaults(forceRefresh),
        ...[...this.byAgent.keys()].map((id) => this.discoverAgent(id, forceRefresh)),
      ]);
      this.pruneAgents();
      this.mergeKnown();
      ids = [...this.known.keys()];
    }
    const entries = await Promise.all(
      [...new Set(ids)].flatMap((id) => {
        const known = reports.get(id);
        if (!known) return [];
        const cacheKey = cacheIdentity(id, known);
        return [
          this.fetchId({
            id,
            known,
            cacheKey,
            forceRefresh,
            allowStale: reportIds === undefined,
          }).then((entry) => {
            if (!entry) return;
            if (this.sources.get(known.source.id) !== known.source) return;
            if (
              known.globalLaunchRevision !== undefined &&
              known.globalLaunchRevision !== this.launchRevision(known.source)
            )
              return;
            if (agentId !== undefined) {
              if (this.trackAgent(agentId)?.state !== agent) {
                this.mergeKnown();
                return;
              }
            } else {
              this.pruneReportAgents(id, cacheKey);
            }
            const current = (agent?.reports ?? this.known).get(id);
            if (!current || cacheIdentity(id, current) !== cacheKey) return;
            options.onReport?.(entry);
            return entry;
          }),
        ];
      }),
    );
    return entries.filter((entry) => entry !== undefined);
  }

  private pruneAgents(): void {
    let changed = false;
    for (const [id, state] of this.byAgent) {
      if (this.trackAgent(id)?.state !== state) changed = true;
    }
    if (changed) this.mergeKnown();
  }

  private pruneReportAgents(id: string, cacheKey: string): void {
    const host = this.defaults.get(id);
    if (host && cacheIdentity(id, host) === cacheKey) return;
    let changed = false;
    for (const [agentId, state] of this.byAgent) {
      if (state.reports.has(id) && this.trackAgent(agentId)?.state !== state) changed = true;
    }
    if (changed) this.mergeKnown();
  }

  private trackAgent(agentId: string) {
    const session = this.agents.hasAgent(agentId) ? this.agents.usageSession(agentId) : null;
    const previous = this.byAgent.get(agentId);
    const scope: UsageScope | null = session && {
      kind: "session",
      provider: session.provider,
      model: session.model,
      env: session.env,
      launch: session.launch,
    };
    const signature = scope ? hashJson(scope) : null;
    if (session && scope && signature) {
      if (previous?.sessionKey === session.sessionKey && previous.signature === signature)
        return { state: previous, scope };
      const state: AgentReports = { sessionKey: session.sessionKey, signature, reports: new Map() };
      this.byAgent.set(agentId, state);
      this.retireDiscovery(previous);
      return { state, scope };
    }
    this.byAgent.delete(agentId);
    this.retireDiscovery(previous);
    return null;
  }

  private retireDiscovery(previous: AgentReports | undefined): void {
    if (
      previous &&
      ![...this.byAgent.values()].some((agent) => agent.signature === previous.signature)
    ) {
      this.sessionDiscovery.delete(previous.signature);
    }
  }

  private invalidateDiscovery(): void {
    this.globalDiscovery = createDiscoveryScope();
    this.sessionDiscovery.clear();
  }

  private async discoverDefaults(forceRefresh: boolean): Promise<void> {
    const discovery = this.globalDiscovery;
    await this.discover({ kind: "global" }, discovery, forceRefresh);
    if (this.globalDiscovery === discovery) this.defaults = this.discoveredReports(discovery);
  }

  private async discoverAgent(
    agentId: string,
    forceRefresh: boolean,
  ): Promise<AgentReports | null> {
    const tracked = this.trackAgent(agentId);
    if (!tracked) return null;
    const { scope, state } = tracked;
    const revision = this.globalDiscovery;
    const signature = state.signature;
    const discovery = this.sessionDiscovery.get(signature) ?? createDiscoveryScope();
    this.sessionDiscovery.delete(signature);
    this.sessionDiscovery.set(signature, discovery);
    discovery.active++;
    try {
      this.trimSessionDiscovery();
      await this.discover(scope, discovery, forceRefresh);
      if (this.trackAgent(agentId)?.state !== state) return null;
      if (this.globalDiscovery === revision) state.reports = this.discoveredReports(discovery);
      return state;
    } finally {
      discovery.active--;
      this.trimSessionDiscovery();
    }
  }

  private trimSessionDiscovery(): void {
    if (this.sessionDiscovery.size <= SESSION_DISCOVERY_LIMIT) return;
    for (const [signature, discovery] of this.sessionDiscovery) {
      if (!discovery.active) this.sessionDiscovery.delete(signature);
      if (this.sessionDiscovery.size <= SESSION_DISCOVERY_LIMIT) break;
    }
  }

  private mergeKnown(): void {
    this.known.clear();
    for (const reports of [
      this.defaults,
      ...[...this.byAgent.values()].map((agent) => agent.reports),
    ]) {
      for (const [id, report] of reports) {
        if (this.sources.get(report.source.id) !== report.source) continue;
        const known = this.known.get(id);
        if (!known) {
          this.known.set(id, { ...report, logins: [...report.logins] });
          continue;
        }
        for (const login of report.logins) {
          if (!known.logins.some((existing) => loginKey(existing) === loginKey(login)))
            known.logins.push(login);
        }
      }
    }
    // Fetch freshness expires independently of successful snapshots. Retain only live identities.
    const active = this.activeCacheKeys();
    for (const key of this.successful.keys()) if (!active.has(key)) this.successful.delete(key);
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
    for (const key of this.pending.keys()) if (!active.has(key)) this.pending.delete(key);
  }

  private activeCacheKeys(): Set<string> {
    return new Set(
      [
        this.known,
        this.defaults,
        ...[...this.byAgent.values()].map((agent) => agent.reports),
      ].flatMap((reports) => [...reports].map(([id, report]) => cacheIdentity(id, report))),
    );
  }

  private async discover(scope: UsageScope, state: DiscoveryScope, forceRefresh: boolean) {
    let snapshot: UsageScope | undefined;
    await Promise.all(
      [...this.sources.values()].map((source) => {
        const cached = state.sources.get(source);
        if (!forceRefresh && cached && this.now() < cached.expiresAt) return;
        const pending = state.pending.get(source);
        if (pending) return pending;
        // A shared request must see the environment used to compute its signature.
        snapshot ??= scope.kind === "session" ? structuredClone(scope) : scope;
        const request = this.discoverSource(snapshot, state, source);
        state.pending.set(source, request);
        const clear = () => {
          if (state.pending.get(source) === request) state.pending.delete(source);
        };
        void request.then(clear, clear);
        return request;
      }),
    );
  }

  private discoveredReports(state: DiscoveryScope): KnownReports {
    const merged: KnownReports = new Map();
    for (const source of this.sources.values()) {
      for (const [id, report] of state.sources.get(source)?.reports ?? []) merged.set(id, report);
    }
    return merged;
  }

  private async discoverSource(scope: UsageScope, state: DiscoveryScope, source: UsageSource) {
    const globalLaunchRevision =
      scope.kind === "global" && source.provider ? this.launchRevision(source) : undefined;
    let reports: KnownReports = new Map();
    let ttl = this.ttlMs;
    try {
      const accounts = z
        .array(
          z.object({
            key: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
            label: z.string().optional(),
            harness: z.string().min(1).optional(),
            input: z.json(),
          }),
        )
        .parse(await source.discover(scope));
      for (const account of accounts) {
        const id = `${source.id}:${account.key}`;
        const known = reports.get(id);
        // COMPAT(usageLoginHarness): added in v0.11.0, remove after 2027-04-05 once plugin floor >= v0.11.0.
        const login = { input: account.input, harness: account.harness ?? source.label };
        if (known) {
          if (!known.logins.some((existing) => loginKey(existing) === loginKey(login)))
            known.logins.push(login);
        } else
          reports.set(id, { source, logins: [login], label: account.label, globalLaunchRevision });
      }
    } catch (error) {
      this.logger.warn({ sourceId: source.id, err: error }, "Usage source discovery failed");
      ttl = Math.min(ttl, DISCOVERY_RETRY_MS);
      // A failed host store read does not confirm removal.
      if (scope.kind === "global") {
        const previous = state.sources.get(source);
        reports =
          previous?.reports ??
          new Map([...this.defaults].filter(([, report]) => report.source === source));
      }
    }
    if (reports.size === 0) ttl = Math.min(ttl, DISCOVERY_RETRY_MS);
    if (this.sources.get(source.id) !== source) return;
    if (globalLaunchRevision !== undefined && globalLaunchRevision !== this.launchRevision(source))
      return;
    state.sources.set(source, { expiresAt: this.now() + ttl, reports });
  }

  // COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
  async listLegacyUsage(): Promise<{ fetchedAt: string; providers: ProviderUsage[] }> {
    const reports = await this.listReports();
    return {
      fetchedAt: reports.length
        ? reports.reduce(
            (oldest, entry) => (entry.fetchedAt < oldest ? entry.fetchedAt : oldest),
            reports[0]!.fetchedAt,
          )
        : new Date(this.now()).toISOString(),
      providers: reports.map((entry) => ({
        providerId: entry.sourceId,
        displayName: entry.account.label
          ? `${entry.sourceLabel} (${entry.account.label})`
          : entry.sourceLabel,
        status: entry.report.status,
        planLabel: entry.report.status === "available" ? (entry.report.planLabel ?? null) : null,
        windows: entry.report.status === "available" ? entry.report.windows : [],
        balances: entry.report.status === "available" ? (entry.report.balances ?? []) : [],
        details: entry.report.status === "available" ? (entry.report.details ?? []) : [],
        error: legacyError(entry.report, this.now()),
      })),
    };
  }

  private fetchId(options: FetchReportOptions): Promise<UsageReportEntry | undefined> {
    // Account identity groups cards; the ordered login set identifies a fetch result.
    const { id, known, cacheKey, forceRefresh, allowStale } = options;
    const cached = this.cache.get(cacheKey);
    if (!forceRefresh && cached && this.now() - cached.at < this.ttlMs)
      return Promise.resolve(cached.entry);
    const request = this.pending.get(cacheKey) ?? this.startFetch(id, known, cacheKey);
    // Targeted and explicit refreshes report this attempt. Lists with a successful
    // snapshot can finish while their expired sources refresh in the background.
    if (!forceRefresh && allowStale && cached && this.successful.has(cacheKey))
      return Promise.resolve(cached.entry);
    return request;
  }

  private startFetch(
    id: string,
    known: KnownReport,
    cacheKey: string,
  ): Promise<UsageReportEntry | undefined> {
    const fetchedAt = new Date(this.now()).toISOString();
    const request = this.fetchWithFallback(known).then((outcome) => {
      if (this.pending.get(cacheKey) !== request) return;
      this.pruneReportAgents(id, cacheKey);
      if (this.pending.get(cacheKey) !== request) return;
      const completedAt = new Date(this.now()).toISOString();
      const entry: UsageReportEntry = {
        id,
        sourceId: known.source.id,
        sourceLabel: known.source.label,
        icon: known.source.icon,
        account: { label: known.label },
        fetchedAt,
        ...outcome,
      };
      if (entry.report.status === "available") {
        entry.successfulAt = completedAt;
        this.successful.set(cacheKey, {
          fetchedAt: completedAt,
          report: entry.report,
        });
      } else {
        entry.lastSuccessful = this.successful.get(cacheKey);
      }
      this.cache.set(cacheKey, { at: this.now(), entry });
      return entry;
    });
    this.pending.set(cacheKey, request);
    const clear = () => {
      if (this.pending.get(cacheKey) === request) this.pending.delete(cacheKey);
    };
    void request.then(clear, clear);
    return request;
  }

  private async fetchBeforeDeadline(source: UsageSource, input: unknown): Promise<UsageReport> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<UsageReport>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: "error", error: "Usage fetch timed out" }),
        this.deadlineMs,
      );
    });
    try {
      return await Promise.race([this.fetchLogin(source, input), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchWithFallback(
    known: KnownReport,
  ): Promise<Pick<UsageReportEntry, "report" | "loginErrors">> {
    // Start each login within the same deadline window, then prefer discovery order.
    // Sequential deadlines can exceed the client's RPC timeout before all errors arrive.
    const attempts = known.logins.map((login) =>
      this.fetchBeforeDeadline(known.source, login.input),
    );
    const loginErrors: NonNullable<UsageReportEntry["loginErrors"]> = [];
    for (const [index, login] of known.logins.entries()) {
      const report = await attempts[index]!;
      if (report.status === "available") return { report };
      loginErrors.push({ harness: login.harness, report });
    }
    // COMPAT(usageLoginErrors): added in v0.11.0, remove after 2027-04-05 once app floor >= v0.11.0.
    // Keep the final single report so older apps still parse and display failed accounts.
    return { report: loginErrors[loginErrors.length - 1]!.report, loginErrors };
  }

  private async fetchLogin(source: UsageSource, input: unknown): Promise<UsageReport> {
    try {
      return UsageReportSchema.parse(await source.fetch(input));
    } catch (error) {
      this.logger.warn({ sourceId: source.id, err: error }, "Usage fetch failed");
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// The legacy RPC has only an error string; the current app owns its own presentation.
// COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
function legacyProblem(problem: UsageProblem, now: number): string {
  if (problem.kind === "no_quota") return problem.detail;
  const remedy = problem.refreshedBy
    ? `Run ${problem.refreshedBy} to refresh it.`
    : "Sign in again.";
  if (problem.kind === "rejected") return `Login rejected (HTTP ${problem.status}). ${remedy}`;
  const elapsed = Math.max(0, now - Date.parse(problem.expiresAt));
  let ago = "just now";
  if (elapsed >= 86_400_000) ago = `${Math.floor(elapsed / 86_400_000)}d ago`;
  else if (elapsed >= 3_600_000) ago = `${Math.floor(elapsed / 3_600_000)}h ago`;
  else if (elapsed >= 60_000) ago = `${Math.floor(elapsed / 60_000)}m ago`;
  return `Login expired ${ago}. ${remedy}`;
}

// COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
function legacyError(report: UsageReport, now: number): string | null {
  if (report.status === "error") return report.error;
  if (report.status === "unavailable") return legacyProblem(report.problem, now);
  return null;
}

// Inputs are opaque JSON locators. Canonical equality deduplicates discovery across scopes.
function canonicalJson(input: unknown): string {
  return JSON.stringify(input, (_key, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : Number(a > b))))
      : value,
  );
}

function loginKey(login: Login): string {
  return canonicalJson(login);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function cacheIdentity(id: string, known: KnownReport): string {
  return `${id}:${hashJson([known.label, known.logins])}`;
}

interface FetchReportOptions {
  id: string;
  known: KnownReport;
  cacheKey: string;
  forceRefresh: boolean;
  allowStale: boolean;
}
