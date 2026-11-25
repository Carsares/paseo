import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { webSocketProxyAgent } from "./index.js";
import {
  UnpublishedProxyCredentialError,
  type ProxyCredentialStore,
} from "./proxy-credential-store.js";
import { diagnoseProxy } from "./proxy-diagnostics.js";
import {
  parseHostProxySettings,
  proxyEndpoints,
  proxySlots,
  updateProxyCredentials,
  type HostProxySettings,
  type ProxyControlPlane,
  type ProxyCredentialChanges,
  type ProxyCredentials,
} from "./proxy-settings.js";
import { ProxyTransport } from "./proxy-transport.js";

interface StoredSettings {
  settings: HostProxySettings;
  credentialId?: string;
}

export interface StoredHostProxySettings {
  revision: number;
  current: StoredSettings;
  previous?: StoredSettings;
  retiredCredentialIds?: string[];
}

/** Publish one durable, atomic settings record under a revision check across all writers.
 * False or rejection must conclusively mean this attempt's record was never published.
 * The adapter must resolve ambiguous writes before returning an outcome. A retired ID may
 * never be published again. Revision zero is the baseline when no record exists.
 * After a process crash, sweeping unreferenced records requires an authoritative load and
 * exclusion of all writers across credential staging and settings publication. */
export interface HostProxySettingsStore {
  load(): Promise<StoredHostProxySettings | undefined>;
  compareAndSet(
    expectedRevision: number,
    next: StoredHostProxySettings,
    canCommit?: () => boolean,
  ): Promise<boolean>;
}

export class ProxyCommitUncertainError extends Error {}
export class ProxyRevisionConflictError extends Error {}
export class ProxyRetestRequiredError extends Error {}

interface Options {
  settings: HostProxySettingsStore;
  credentials: ProxyCredentialStore;
  trustedLanOrigins?: readonly string[] | (() => readonly string[]);
}

interface Candidate {
  id: string;
  revision: number;
  settings: HostProxySettings;
  credentials: ProxyCredentials;
  transport: ProxyTransport;
  expiresAt: number;
  timer: NodeJS.Timeout;
  owner?: object;
}

const VALIDATION_TTL_MS = 60_000;
const DIAGNOSTIC_INTERVAL_MS = 2_000;
type Scope = "outbound" | ProxyControlPlane;

export class HostProxyRuntime {
  readonly #lifetime = new AbortController();
  #candidate?: Candidate;
  #operation?: Promise<unknown>;
  #nextDiagnostic = 0;
  #closePromise?: Promise<void>;
  #credentialCleanupPending = new Set<string>();
  #commitUncertain = false;

  private constructor(
    private readonly options: Options,
    private state: StoredHostProxySettings,
    private credentials: ProxyCredentials,
    private transport: ProxyTransport,
  ) {}

  static async open(options: Options): Promise<HostProxyRuntime> {
    try {
      const state = (await options.settings.load()) ?? {
        revision: 0,
        current: { settings: { mode: "inherit" } },
      };
      if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error();
      const current = {
        ...state.current,
        settings: parseHostProxySettings(state.current.settings),
      };
      const credentials = await HostProxyRuntime.#readCredentials(options, current);
      const trustedOptions = {
        ...options,
        trustedLanOrigins:
          typeof options.trustedLanOrigins === "function"
            ? options.trustedLanOrigins
            : [...(options.trustedLanOrigins ?? [])],
      };
      const transport = new ProxyTransport(
        current.settings,
        credentials,
        trustedOptions.trustedLanOrigins,
      );
      const runtime = new HostProxyRuntime(
        trustedOptions,
        { ...state, current },
        credentials,
        transport,
      );
      await runtime.#retireCredentials(state.retiredCredentialIds ?? []);
      return runtime;
    } catch {
      throw new Error("Could not load host proxy settings");
    }
  }

  static async #readCredentials(
    options: Options,
    record: StoredSettings,
  ): Promise<ProxyCredentials> {
    const credentials = record.credentialId
      ? await options.credentials.read(record.credentialId)
      : {};
    const endpoints = proxyEndpoints(record.settings);
    if (proxySlots.some((slot) => credentials[slot] && !endpoints[slot])) {
      throw new Error("Stored proxy credentials do not match the settings");
    }
    return credentials;
  }

  read() {
    return {
      revision: this.state.revision,
      settings: structuredClone(this.state.current.settings),
      credentialConfigured: {
        unified: Boolean(this.credentials.unified),
        http: Boolean(this.credentials.http),
        https: Boolean(this.credentials.https),
      },
      canRollback: this.state.previous !== undefined,
      credentialCleanupPending: this.#credentialCleanupPending.size > 0,
    };
  }

  get available(): boolean {
    return !this.#commitUncertain && !this.#lifetime.signal.aborted;
  }

  dispatcher(scope: Scope = "outbound") {
    if (scope !== "outbound") return undefined; // Keep the existing dispatcher at the caller.
    if (this.#commitUncertain) throw new Error("Host proxy publication status is uncertain");
    return this.transport.dispatcher;
  }

  webSocket(address: string | URL, signal?: AbortSignal, scope: Scope = "outbound") {
    if (scope === "outbound") return this.transport.webSocket(address, signal);
    const options = { agent: webSocketProxyAgent(String(address)), followRedirects: false, signal };
    return new WebSocket(address, options);
  }

  async validate(
    expectedRevision: number,
    settings: HostProxySettings,
    credentials?: ProxyCredentialChanges,
    owner?: object,
    signal?: AbortSignal,
  ) {
    return this.#exclusive(expectedRevision, async () => {
      const parsed = parseHostProxySettings(settings);
      const next = updateProxyCredentials(
        this.state.current.settings,
        parsed,
        this.credentials,
        credentials,
      );
      return this.#validate(expectedRevision, parsed, next, owner, signal);
    });
  }

  async validateRollback(expectedRevision: number) {
    return this.#exclusive(expectedRevision, async () => {
      const prior = this.state.previous;
      if (!prior) throw new Error("No previous proxy settings available");
      const settings = parseHostProxySettings(prior.settings);
      let credentials: ProxyCredentials;
      try {
        credentials = await HostProxyRuntime.#readCredentials(this.options, { ...prior, settings });
      } catch {
        throw new Error("Could not load previous proxy credentials");
      }
      return this.#validate(expectedRevision, settings, credentials);
    });
  }

  async #validate(
    revision: number,
    settings: HostProxySettings,
    credentials: ProxyCredentials,
    owner?: object,
    signal?: AbortSignal,
  ) {
    const now = performance.now();
    if (now < this.#nextDiagnostic) throw new Error("Proxy diagnostics are rate limited");
    this.#nextDiagnostic = now + DIAGNOSTIC_INTERVAL_MS;
    if (this.#candidate) await this.#discard(this.#candidate);
    const transport = new ProxyTransport(
      settings,
      credentials,
      this.options.trustedLanOrigins ?? [],
    );
    let diagnostics: Awaited<ReturnType<typeof diagnoseProxy>>;
    try {
      const lifetime = signal
        ? AbortSignal.any([this.#lifetime.signal, signal])
        : this.#lifetime.signal;
      diagnostics = await diagnoseProxy(transport, lifetime);
      if (lifetime.aborted) throw new Error("Host proxy validation cancelled");
    } catch (error) {
      await transport.close();
      throw error;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (this.#candidate?.id === id) void this.#discard(this.#candidate);
    }, VALIDATION_TTL_MS).unref();
    this.#candidate = {
      id,
      revision,
      settings,
      credentials,
      transport,
      expiresAt: performance.now() + VALIDATION_TTL_MS,
      timer,
      owner,
    };
    return { validationId: id, revision, expiresInMs: VALIDATION_TTL_MS, diagnostics };
  }

  async #discard(candidate: Candidate) {
    if (this.#candidate === candidate) this.#candidate = undefined;
    clearTimeout(candidate.timer);
    await candidate.transport.close();
  }

  async apply(
    expectedRevision: number,
    validationId: string,
    owner?: object,
    canCommit?: () => boolean,
  ) {
    return this.#exclusive(expectedRevision, async () => {
      const candidate = this.#candidate;
      if (
        !candidate ||
        candidate.id !== validationId ||
        candidate.owner !== owner ||
        candidate.revision !== expectedRevision ||
        performance.now() >= candidate.expiresAt
      ) {
        throw new ProxyRetestRequiredError("Current proxy validation is required");
      }
      const revision = expectedRevision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("Proxy revision limit reached");
      this.#candidate = undefined;
      clearTimeout(candidate.timer);

      const before = this.state;
      const beforeEndpoints = proxyEndpoints(before.current.settings);
      const afterEndpoints = proxyEndpoints(candidate.settings);
      // A rollback must not restore credentials removed with their endpoint.
      const removedCredentials = proxySlots.some(
        (slot) =>
          this.credentials[slot] &&
          (!candidate.credentials[slot] || beforeEndpoints[slot] !== afterEndpoints[slot]),
      );
      const previous = removedCredentials ? undefined : before.current;
      let credentialId: string | undefined;
      let saved: StoredHostProxySettings;
      try {
        if (Object.keys(candidate.credentials).length) {
          credentialId = await this.options.credentials
            .write(candidate.credentials)
            .catch((error: unknown) => {
              if (error instanceof UnpublishedProxyCredentialError) {
                this.#credentialCleanupPending.add(error.credentialId);
              }
              throw error;
            });
        }
        const retired = new Set([
          ...this.#credentialCleanupPending,
          before.previous?.credentialId,
          previous ? undefined : before.current.credentialId,
        ]);
        retired.delete(previous?.credentialId);
        retired.delete(credentialId);
        saved = {
          revision,
          current: { settings: candidate.settings, credentialId },
          previous,
          retiredCredentialIds: [...retired].filter((id) => id !== undefined),
        };
        if (canCommit && !canCommit()) throw new Error("Proxy source no longer authorized");
        if (!(await this.options.settings.compareAndSet(expectedRevision, saved, canCommit)))
          throw new ProxyRevisionConflictError(
            "Could not commit host proxy settings: revision changed",
          );
      } catch (error) {
        if (error instanceof ProxyCommitUncertainError) {
          this.#commitUncertain = true;
          await Promise.all([candidate.transport.close(), this.transport.close()]);
          throw error;
        }
        if (credentialId) this.#credentialCleanupPending.add(credentialId);
        await Promise.all([
          candidate.transport.close(),
          this.#retireCredentials([...this.#credentialCleanupPending]),
        ]);
        if (error instanceof ProxyRevisionConflictError) throw error;
        // oxlint-disable-next-line eslint(preserve-caught-error) -- Storage errors can contain private data.
        throw new Error("Could not commit host proxy settings");
      }

      const oldTransport = this.transport;
      this.state = saved;
      this.credentials = candidate.credentials;
      this.transport = candidate.transport;
      await Promise.all([
        oldTransport.close(),
        this.#retireCredentials(saved.retiredCredentialIds ?? []),
      ]);
      return this.read();
    });
  }

  async #retireCredentials(ids: readonly string[]) {
    const protectedIds = new Set([
      this.state.current.credentialId,
      this.state.previous?.credentialId,
    ]);
    const pending = new Set<string>();
    await Promise.all(
      ids
        .filter((id) => !protectedIds.has(id))
        .map(async (id) => {
          try {
            await this.options.credentials.remove(id);
          } catch {
            pending.add(id);
          }
        }),
    );
    this.#credentialCleanupPending = pending;
  }

  async #exclusive<T>(revision: number, run: () => Promise<T>): Promise<T> {
    if (!this.available) throw new Error("Host proxy runtime unavailable");
    if (this.#operation) throw new Error("Host proxy operation already running");
    if (revision !== this.state.revision)
      throw new ProxyRevisionConflictError("Host proxy revision changed");
    const operation = run();
    this.#operation = operation;
    try {
      return await operation;
    } finally {
      this.#operation = undefined;
    }
  }

  close(): Promise<void> {
    return (this.#closePromise ??= this.#shutdown());
  }

  async #shutdown() {
    this.#lifetime.abort();
    await this.#operation?.catch(() => undefined);
    if (this.#candidate) await this.#discard(this.#candidate);
    await Promise.all([
      this.transport.close(),
      this.#retireCredentials([...this.#credentialCleanupPending]),
    ]);
    this.credentials = {};
  }
}
